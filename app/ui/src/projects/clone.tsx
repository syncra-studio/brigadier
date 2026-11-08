import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { showToast } from "../components/toast";
import { Folder, Link, Plus, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { CancelButton, Footer, Header, OfflineLine, shortPath, type View } from "./add-project";
import { closeAddProject, DEFAULT_PARENT, type GitHub, showProject, type Source } from "./store";

/** `owner/name` is a GitHub repository; anything else is taken as typed (the old app's). */
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;
const cloneUrl = (typed: string) => {
  const url = typed.trim();
  return SHORTHAND.test(url) ? `https://github.com/${url.replace(/\.git$/, "")}.git` : url;
};
/** The folder a clone of `url` goes in: its last path part, without `.git`. */
const folderFromUrl = (url: string) => (url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "").replace(/\.git$/, "");

/**
 * A clone, from the URL field or the GitHub list: the dialog stays open with "Cloning…" until it's
 * done [D168]. Closed meanwhile, the clone goes on and its outcome comes as a toast. Through a lost
 * daemon it stays "Cloning…" and reconciles by id when it's back, never shown failed [D30].
 */
export function useClone(source: Source, started: string | null = null) {
  const [cloning, setCloning] = useState<string | null>(started);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const clone = async (from: string, parent: string, folder: string, github = false) => {
    if (cloning) return;
    setCloning(from);
    setError(null);
    try {
      const id = await source.clone(from, `${parent}${folder}`, github);
      if (mounted.current) closeAddProject();
      showProject(id);
      showToast(`Cloned ${folder}`);
    } catch (cause) {
      if (!mounted.current) return showToast(`Could not clone ${folder}: ${errorText(cause)}`, { tone: "error" });
      setError(errorText(cause));
      setCloning(null);
    }
  };
  return { cloning, error, setError, clone };
}
type Clone = ReturnType<typeof useClone>;

// ----- Clone from URL -----

export function CloneView({
  source,
  offline,
  start,
  github,
  onBack,
}: {
  source: Source;
  offline: boolean;
  start: Extract<View, { kind: "clone" }>;
  github: boolean;
  onBack: () => void;
}) {
  const id = useId();
  const [url, setUrl] = useState(start.url ?? "");
  const [parent, setParent] = useState(DEFAULT_PARENT);
  // The error is about the URL itself: its field shows it.
  const [invalid, setInvalid] = useState(Boolean(start.error));
  const clone = useClone(source, start.cloning ? cloneUrl(start.url ?? "") : null);
  const error = clone.error ?? start.error ?? null;
  const busy = clone.cloning !== null;
  const folder = folderFromUrl(url);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const reason = !url.trim() ? "Paste the repository's URL." : !folder ? "That URL doesn't name a repository." : null;
    setInvalid(Boolean(reason));
    if (reason) return clone.setError(reason);
    void clone.clone(cloneUrl(url), parent, folder);
  };

  return (
    <form onSubmit={submit} className="flex flex-col">
      <Header title="Clone from URL" line="Paste a link to a git repository. We'll copy it to your Mac and add it." onBack={busy ? undefined : onBack} />
      <div className="flex flex-col gap-5.5 px-7 pt-1 pb-7">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor={`${id}-url`} label="Repository URL" />
          <div className={BOX}>
            <Link />
            <input
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
        {github && (
          <div className="flex flex-col gap-2">
            <FieldLabel label="Your GitHub repositories" aside="Click one to clone it" />
            <GitHubRepos source={source} filter={/[:@]/.test(url) ? "" : url} clone={clone} parent={parent} />
          </div>
        )}
        <SaveTo parent={parent} name={folder} aside="Named after the repository" disabled={busy} source={source} onParent={setParent} onError={clone.setError} />
        <div className="flex flex-col gap-1">
          <ErrorLine error={error} />
          <OfflineLine offline={offline && busy} />
        </div>
      </div>
      <Footer>
        <CancelButton label={busy ? "Close" : "Cancel"} />
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Spinner className="animate-spin" />}
          {busy ? "Cloning…" : "Clone and add"}
        </Button>
      </Footer>
    </form>
  );
}

// ----- New repository -----

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
  const [error, setError] = useState<string | null>(start.error ?? null);
  // The error is about the name itself: its field shows it, git's reason included.
  const [invalid, setInvalid] = useState(Boolean(start.error));
  const [busy, setBusy] = useState(false);
  const folder = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!folder || folder === "." || folder === ".." || folder.includes("/")) {
      setError(folder ? `"${folder}" can't be a folder name.` : "Name the repository.");
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await source.add(`${parent}${folder}`, "new");
      closeAddProject();
      showProject(project);
    } catch (cause) {
      setError(errorText(cause));
      setInvalid(true);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col">
      <Header title="New repository" line="Name it and choose where it goes. Brigadier starts git in it and adds it." onBack={busy ? undefined : onBack} />
      <div className="flex flex-col gap-5.5 px-7 pt-1 pb-7">
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
              aria-invalid={invalid || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
                setInvalid(false);
              }}
              className={BOX_INPUT}
            />
          </div>
          <ErrorLine error={error} />
        </div>
        <SaveTo parent={parent} name={folder} disabled={busy} source={source} onParent={setParent} onError={setError} />
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

/** Your GitHub repositories through gh, each cloned in one click into `parent`; without gh, one line why. */
export function GitHubRepos({
  source,
  filter,
  clone,
  parent,
  short = false,
}: {
  source: Source;
  filter: string;
  clone: Clone;
  parent: string;
  /** About three rows high, under Pick's own list. */
  short?: boolean;
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

  const line = (text: string) => <p className="px-3 text-sm text-muted-foreground">{text}</p>;
  if (error) return <ErrorLine error={error} className="px-3" />;
  if (!list) return line("Looking for your repositories…");
  if ("gh" in list)
    return line(list.gh === "missing" ? "Install the GitHub CLI (gh) to see your repositories here." : "Sign in with gh auth login to see your repositories here.");
  const words = filter.trim().toLowerCase();
  const shown = list.repos.filter((repo) => repo.name.toLowerCase().includes(words));
  if (list.repos.length === 0) return line("No repositories on GitHub yet.");
  if (shown.length === 0) return line("No repository matches.");
  return (
    <div className={cx("flex flex-col gap-0.5 overflow-y-auto", short ? "max-h-32" : "max-h-add-project-list")}>
      {shown.map((repo) => {
        const folder = repo.name.split("/")[1]!;
        const mine = clone.cloning === repo.name;
        return (
          <button
            key={repo.name}
            type="button"
            disabled={clone.cloning !== null}
            onClick={() => void clone.clone(repo.name, parent, folder, true)}
            className={cx(
              "flex h-10.5 w-full shrink-0 cursor-pointer items-center gap-3 rounded-surface px-3 text-start outline-none focus-visible:focus-ring",
              "hover:bg-fill-subtle disabled:cursor-not-allowed",
              clone.cloning !== null && !mine && "opacity-row-disabled",
            )}
          >
            <span className="shrink-0 font-mono text-xs">{repo.name}</span>
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
function FieldLabel({ htmlFor, label, aside }: { htmlFor?: string; label: string; aside?: string }) {
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
const BOX = cx(
  "flex h-10.5 items-center gap-2.5 rounded-capsule border border-transparent bg-fill ps-3.5 pe-1.5 transition-colors",
  "focus-within:bg-background focus-within:focus-ring has-aria-invalid:border-invalid has-disabled:opacity-disabled",
  "svg:size-icon-sm svg:shrink-0 svg-uncoloured:text-muted-foreground",
);
const BOX_INPUT = "h-full min-w-0 flex-1 cursor-text bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground";

/** Save to: the folder it goes in (dimmer) and its own name brighter, with Change… for another parent. */
function SaveTo({
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
