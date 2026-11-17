import { type FormEvent, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { showToast } from "../components/toast";
import { Folder, Link, Plus, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { CancelButton, Footer, Header, OfflineLine, shortPath, type View } from "./add-project";
import { newProjectId, useProjects } from "./projects";
import { closeAddProject, DEFAULT_PARENT, type GitHub, showProject, type Source } from "./store";

/** `owner/name` is a GitHub repository; anything else is taken as typed (the old app's). */
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;
export const cloneUrl = (typed: string) => {
  const url = typed.trim();
  return SHORTHAND.test(url) ? `https://github.com/${url.replace(/\.git$/, "")}.git` : url;
};
/** The folder a clone of `url` goes in: its last path part, without `.git`. */
export const folderFromUrl = (url: string) => (url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "").replace(/\.git$/, "");

/**
 * An add the dialog waits on (a clone, a new repository, a folder git starts in) under an id made
 * here: "Cloning…" or the button's spinner until it's done [D168]. Closed meanwhile, it goes on and
 * a toast tells how it ended. Through a lost daemon it keeps waiting and settles when the projects
 * list holds its id, never shown failed [D30].
 */
export function useAdd() {
  const [running, setRunning] = useState<{ id: string; what: string; done?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const finish = (id: string, done?: string) => {
    if (mounted.current) closeAddProject();
    showProject(id);
    if (done) showToast(done);
  };
  const projects = useProjects();
  const settled = away && running && projects?.some((project) => project.id === running.id && !project.pending) ? running : null;
  const finishSettled = useEffectEvent(finish);
  useEffect(() => {
    if (settled) finishSettled(settled.id, settled.done);
  }, [settled]);
  /** Runs `work` under a new id; `done` is the toast after, `failed` what a toast says when closed. */
  const start = async (what: string, work: (id: string) => Promise<unknown>, done?: string, failed?: string) => {
    if (running) return;
    const id = newProjectId();
    setRunning({ id, what, done });
    setError(null);
    setAway(false);
    try {
      await work(id);
      finish(id, done);
    } catch (cause) {
      const reason = errorText(cause);
      if (reason === "disconnected") return setAway(true);
      if (!mounted.current) return showToast(failed ? `${failed}: ${reason}` : reason, { tone: "error" });
      setError(reason);
      setRunning(null);
    }
  };
  return { running: running?.what ?? null, error, setError, start };
}
type Add = ReturnType<typeof useAdd>;

/** A clone of `from` (a URL, or with `github` an `owner/name`, as `account` when given) into `parent` + `folder`. */
const cloneInto = (add: Add, source: Source, from: string, parent: string, folder: string, github = false, account?: string) =>
  add.start(from, (id) => source.clone(id, from, `${parent}${folder}`, github, account), `Cloned ${folder}`, `Could not clone ${folder}`);

// ----- Clone from URL -----

export function CloneView({
  source,
  offline,
  onBack,
}: {
  source: Source;
  offline: boolean;
  onBack: () => void;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(DEFAULT_PARENT);
  // The error is about the URL itself: its field shows it.
  const [invalid, setInvalid] = useState(false);
  const clone = useAdd();
  const error = clone.error;
  const busy = clone.running !== null;
  const folder = folderFromUrl(url);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (clone.error && !busy) field.current?.focus();
  }, [clone.error, busy]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const reason = !folder ? "That URL doesn't name a repository." : null;
    setInvalid(Boolean(reason));
    if (reason) return clone.setError(reason);
    void cloneInto(clone, source, cloneUrl(url), parent, folder);
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 min-w-0 flex-col">
      <Header title="Clone from URL" line="Paste a link to a git repository. We'll copy it to your Mac and add it." onBack={busy ? undefined : onBack} />
      <div className="scroll-gutter flex min-h-0 flex-col gap-5.5 overflow-y-auto ps-7 pe-4.5 pt-1 pb-7">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={`${id}-url`} label="Repository URL" />
          <div className={BOX}>
            <Link />
            <input
              ref={field}
              id={`${id}-url`}
              value={url}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              placeholder="https://github.com/owner/repo.git"
              aria-invalid={invalid || undefined}
              onChange={(event) => {
                setUrl(event.target.value);
                clone.setError(null);
                setInvalid(false);
              }}
              className={BOX_INPUT}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel label="Your GitHub repositories" aside="Click one to clone it" />
          <GitHubRepos
            source={source}
            filter={/[:@]/.test(url) ? "" : url}
            running={clone.running}
            onPick={(name, account) => void cloneInto(clone, source, name, parent, name.split("/")[1]!, true, account)}
          />
        </div>
        <SaveTo parent={parent} name={folder} aside="Named after the repository" disabled={busy} source={source} onParent={setParent} onError={clone.setError} />
        <div className="flex flex-col gap-1">
          <ErrorLine error={error} />
          <OfflineLine offline={offline && busy} />
        </div>
      </div>
      <Footer>
        <CancelButton label={busy ? "Close" : "Cancel"} />
        <Button size="sm" type="submit" disabled={busy || !url.trim()}>
          {busy && <Spinner className="animate-spin" />}
          {busy ? "Cloning…" : "Clone and add"}
        </Button>
      </Footer>
    </form>
  );
}

// ----- New repository -----

/** Why a new repository's name can't be its folder's, or null. */
export const folderProblem = (folder: string) =>
  !folder || folder === "." || folder === ".." || folder.includes("/") ? (folder ? `"${folder}" can't be a folder name.` : "Name the repository.") : null;

export function NewRepoView({
  source,
  offline,
  start,
  onBack,
}: {
  source: Source;
  offline: boolean;
  start: Extract<View, { kind: "new" }>;
  onBack: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(start.name);
  const [parent, setParent] = useState(start.parent);
  const add = useAdd();
  const [typed, setTyped] = useState<string | null>(null);
  const error = typed ?? add.error;
  const busy = add.running !== null;
  const folder = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const problem = folderProblem(folder);
    if (problem) return setTyped(problem);
    void add.start(folder, (id) => source.add(id, `${parent}${folder}`, "new"));
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <Header title="New repository" line="Name it and choose where it goes. Brigadier starts git in it and adds it." onBack={busy ? undefined : onBack} />
      <div className="scroll-gutter flex min-h-0 flex-col gap-5.5 overflow-y-auto ps-7 pe-4.5 pt-1 pb-7">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={`${id}-name`} label="Name" />
          <div className={BOX}>
            <Plus />
            <input
              id={`${id}-name`}
              value={name}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              maxLength={200}
              disabled={busy}
              placeholder="my-project"
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setTyped(null);
                add.setError(null);
              }}
              className={BOX_INPUT}
            />
          </div>
          <ErrorLine error={error} />
        </div>
        <SaveTo parent={parent} name={folder} disabled={busy} source={source} onParent={setParent} onError={setTyped} />
        <OfflineLine offline={offline && busy} />
      </div>
      <Footer>
        <CancelButton />
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Spinner className="animate-spin" />}
          Create and add
        </Button>
      </Footer>
    </form>
  );
}

// ----- Your GitHub repositories [D202] -----

/** Your GitHub repositories through gh, each picked in one click (`chosen` shows as picked); without gh, one line why. */
export function GitHubRepos({
  source,
  filter,
  running,
  chosen,
  onPick,
}: {
  source: Source;
  filter: string;
  /** What's being cloned now: the rest wait. */
  running: string | null;
  chosen?: string;
  /** The repository, and the signed-in account that sees it [D625]. */
  onPick: (name: string, account?: string) => void;
}) {
  const [list, setList] = useState<GitHub | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    source.github().then(
      (answer) => live && setList(answer),
      (cause: unknown) => live && setError(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, [source]);

  const height = "h-add-project-list";
  const line = (text: string) => <p className={cx("shrink-0 overflow-y-auto px-3 text-sm text-muted-foreground", height)}>{text}</p>;
  if (error) return <div className={cx("shrink-0 overflow-y-auto px-3", height)}><ErrorLine error={error} /></div>;
  if (!list) return line("Looking for your repositories…");
  if ("gh" in list)
    return line(list.gh === "missing" ? "Install the GitHub CLI (gh) to see your repositories here." : "Sign in with gh auth login to see your repositories here.");
  const words = filter.trim().toLowerCase();
  const shown = list.repos.filter((repo) => repo.name.toLowerCase().includes(words));
  if (list.repos.length === 0) return line("No repositories on GitHub yet.");
  if (shown.length === 0) return line("No repository matches.");
  return (
    <div className={cx("flex shrink-0 flex-col gap-0.5 overflow-y-auto", height)}>
      {shown.map((repo) => {
        const mine = running === repo.name;
        return (
          <button
            key={repo.name}
            type="button"
            aria-pressed={chosen === undefined ? undefined : chosen === repo.name}
            disabled={running !== null}
            onClick={() => onPick(repo.name, repo.account)}
            className={cx(
              "flex h-10.5 w-full shrink-0 cursor-pointer items-center gap-3 rounded-surface px-3 text-start outline-none focus-visible:focus-ring",
              "hover:bg-fill-subtle disabled:cursor-not-allowed aria-pressed:bg-fill-hover",
              running !== null && !mine && "opacity-row-disabled",
            )}
          >
            <span className="min-w-0 truncate font-mono text-xs" title={repo.name}>{repo.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{repo.description}</span>
            {repo.private && <Badge variant="outline">Private</Badge>}
            {mine && <Spinner className="size-icon-sm shrink-0 animate-spin" />}
          </button>
        );
      })}
    </div>
  );
}

// ----- fields -----

/** A field's label, with an optional note on the right. */
export function FieldLabel({ htmlFor, label, aside }: { htmlFor?: string; label: string; aside?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <label htmlFor={htmlFor} className="font-medium text-foreground">
        {label}
      </label>
      {aside && <span className="text-muted-foreground">{aside}</span>}
    </div>
  );
}

/** A 42-high capsule for a field, in the Input's look: its icon, then its content. */
export const BOX = cx(
  "flex h-10.5 items-center gap-2.5 rounded-capsule border border-transparent bg-fill ps-3.5 pe-1.5 transition-colors",
  "focus-within:bg-background focus-within:focus-ring has-aria-invalid:border-invalid has-disabled:opacity-disabled",
  "svg:size-icon-sm svg:shrink-0 svg-uncoloured:text-muted-foreground",
);
export const BOX_INPUT = "h-full min-w-0 flex-1 cursor-text bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground";

/** Save to: the folder it goes in (dimmer) and its own name brighter, with Change… for another parent. */
export function SaveTo({
  parent,
  name,
  aside,
  disabled,
  source,
  onParent,
  onError,
}: {
  parent: string;
  name: string;
  aside?: string;
  disabled: boolean;
  source: Source;
  onParent: (parent: string) => void;
  onError: (error: string) => void;
}) {
  const change = () =>
    source.pick(parent).then(
      (picked) => picked && onParent(`${shortPath(picked).replace(/\/+$/, "")}/`),
      (cause: unknown) => onError(errorText(cause)),
    );
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel label="Save to" aside={aside} />
      <div className={BOX}>
        <Folder />
        <p className="flex min-w-0 flex-1 font-mono text-xs">
          <span className="min-w-0 truncate text-muted-foreground">{parent}</span>
          <span className="shrink-0 text-foreground">{name}</span>
        </p>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void change()}>
          Change…
        </Button>
      </div>
    </div>
  );
}
