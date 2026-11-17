import { type ReactNode, useEffect, useRef } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { ChevronRight, Folder, FolderOpen, Spinner } from "../icons";
import { Avatar } from "../landing/pr-parts";
import { BOX, BOX_INPUT } from "../projects/clone";
import type { GitHub } from "../projects/store";
import { BrandMark } from "../settings/plugins-marks";

/*
 * The Projects step's three tabs, in our kit [D616, D627]: a line of help, one field, a list under it. What's
 * typed and picked is the step's, which clones, adds or creates it with its footer's button.
 */

export const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
/** A home-relative path for display (`~/Development/app`), as the old app showed it. */
export const shortPath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, "~");

const ROW = cx(
  "flex h-10.5 w-full shrink-0 cursor-pointer items-center gap-3 rounded-surface px-3 text-start text-sm outline-none focus-visible:focus-ring",
  "hover:bg-fill-subtle aria-pressed:bg-fill-hover disabled:cursor-not-allowed",
);

function Tab({ help, field, children }: { help: string; field: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="text-sm text-muted-foreground">{help}</p>
      {field}
      {children && <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-1">{children}</div>}
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="px-3 py-2 text-sm text-muted-foreground">{children}</p>;

/** A repository from any signed-in GitHub account, or any URL; the list is every account's, typing filters it [D625]. */
export function CloneTab({ repo, github, busy, onRepo }: { repo: string; github: GitHub | null; busy: boolean; onRepo: (repo: string) => void }) {
  const url = /[:@]/.test(repo);
  const words = url ? "" : repo.trim().toLowerCase();
  const repos = github && "repos" in github ? github.repos.filter((each) => each.name.toLowerCase().includes(words)) : [];
  return (
    <Tab
      help="Clone a repository from GitHub."
      field={
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
            // A pasted GitHub link is its owner/name, so it clones with the account that sees it.
            onChange={(event) => onRepo(event.target.value.replace(/^\s*(https?:\/\/)?github\.com\//, ""))}
            className={BOX_INPUT}
          />
        </div>
      }
    >
      {github && "gh" in github ? (
        <Note>
          {github.gh === "missing" ? "Install the GitHub CLI (gh) to see your repositories here." : "Connect GitHub on the step before to see your repositories here."} Any
          repository's URL works too.
        </Note>
      ) : github && repos.length === 0 ? (
        <Note>{github.repos.length ? "No repository matches." : "No repositories on GitHub yet."}</Note>
      ) : (
        repos.map((each) => {
          const [owner, name] = each.name.split("/");
          return (
            <button key={each.name} type="button" aria-pressed={repo === each.name} disabled={busy} onClick={() => onRepo(each.name)} className={ROW}>
              <Avatar login={owner ?? null} />
              <span className="min-w-0 truncate">
                <span className="text-muted-foreground">{owner} / </span>
                <span className="font-medium">{name}</span>
              </span>
              {busy && repo === each.name && <Spinner className="ms-auto size-icon-sm shrink-0 animate-spin" />}
            </button>
          );
        })
      )}
    </Tab>
  );
}

/** A folder on this computer: the agents' history to search, or any folder through the picker. */
export function FolderTab({ query, onQuery, paths, chosen, onChoose, onPick, picking, busy }: {
  query: string;
  onQuery: (query: string) => void;
  paths: readonly string[] | null;
  chosen: string | null;
  onChoose: (path: string) => void;
  onPick: () => void;
  picking: boolean;
  busy: boolean;
}) {
  const words = query.trim().toLowerCase();
  const shown = (paths ?? []).filter((path) => path.toLowerCase().includes(words));
  return (
    <Tab
      help="Pick a project from your machine. You can choose any folder on disk."
      field={
        <div className={cx(BOX, "pe-1.5")}>
          <input value={query} autoFocus spellCheck={false} autoComplete="off" disabled={busy} placeholder="Search projects…" aria-label="Search projects" onChange={(event) => onQuery(event.target.value)} className={cx(BOX_INPUT, "font-sans text-sm")} />
          <TooltipIconButton tooltip="Choose a folder…" disabled={busy || picking} onClick={onPick}>
            {picking ? <Spinner className="animate-spin" /> : <FolderOpen />}
          </TooltipIconButton>
        </div>
      }
    >
      {paths?.length === 0 ? (
        <Note>No projects in your agents' history yet. Choose any folder with the folder button.</Note>
      ) : paths && shown.length === 0 ? (
        <Note>No project matches.</Note>
      ) : (
        shown.map((path) => (
          <button key={path} type="button" aria-pressed={chosen === path} disabled={busy} onClick={() => onChoose(path)} className={ROW}>
            <Folder className="size-icon-sm shrink-0 text-muted-foreground" />
            <span className="min-w-0 shrink-0 truncate font-medium">{baseName(path)}</span>
            <span title={path} className="ms-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
              {shortPath(path)}
            </span>
            <ChevronRight className="size-icon-sm shrink-0 text-muted-foreground" />
          </button>
        ))
      )}
    </Tab>
  );
}

/** A new folder: where it goes (its picker) and its name; git starts in it. */
export function NewTab({ name, onName, parent, onParent, busy }: { name: string; onName: (name: string) => void; parent: string; onParent: () => void; busy: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  // The name is there to be typed over.
  useEffect(() => field.current?.select(), []);
  return (
    <Tab
      help="Start fresh from scratch. We'll make a new folder and start git in it."
      field={
        <div className={cx(BOX, "ps-1.5")}>
          <button type="button" disabled={busy} onClick={onParent} title="Choose where it goes" className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-capsule px-2 font-mono text-xs text-muted-foreground outline-none hover:bg-fill-hover hover:text-foreground focus-visible:focus-ring">
            <Folder />
            {parent}
          </button>
          <span aria-hidden className="h-5 w-px shrink-0 bg-divider" />
          <input ref={field} value={name} autoFocus spellCheck={false} autoComplete="off" maxLength={200} disabled={busy} aria-label="Name" placeholder="my-project" onChange={(event) => onName(event.target.value)} className={BOX_INPUT} />
        </div>
      }
    />
  );
}
