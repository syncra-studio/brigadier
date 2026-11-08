import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Check, ChevronDown, ChevronRight, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import type { FilesProps } from "./settings";

/*
 * Look (b) for the files copied into worktrees (O20) [D178]: the repo's ignored files as Rust lists
 * them, a folder opening on its own, each one ticked to copy; a path not listed is added by hand. What
 * the repo's own .worktreeinclude copies shows apart, always copied [D211].
 */

type Listing = { entries: string[]; copied: string[] } | "loading" | { error: string };

const bare = (path: string) => path.replace(/\/+$/, "");
const leaf = (path: string) => bare(path).split("/").at(-1) ?? path;

export function DiscoveredFiles({ project, source, files, onFiles }: FilesProps) {
  const [listed, setListed] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const load = (dir: string) => {
    setListed((now) => ({ ...now, [dir]: "loading" }));
    source.ignored(project.id, dir).then(
      (listing) => setListed((now) => ({ ...now, [dir]: listing })),
      (cause) => setListed((now) => ({ ...now, [dir]: { error: errorText(cause) } })),
    );
  };
  useEffect(() => load(""), [project.id]);
  const picked = (path: string) => files.includes(bare(path));
  // A file inside a ticked folder goes with it.
  const inPicked = (path: string) => files.some((each) => bare(path).startsWith(`${each}/`));
  const toggle = (path: string, on: boolean) => onFiles(on ? [...files, bare(path)] : files.filter((each) => each !== bare(path)));
  const shown = new Set(Object.values(listed).flatMap((each) => (typeof each === "object" && "entries" in each ? each.entries.map(bare) : [])));
  const root = listed[""];
  const copied = typeof root === "object" && "copied" in root ? root.copied : [];

  const rows = (dir: string, depth: number) => {
    const listing = listed[dir];
    if (listing === undefined || listing === "loading")
      return (
        <li className="flex h-7 items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="animate-spin" />
          Looking for ignored files…
        </li>
      );
    if ("error" in listing)
      return (
        <li>
          <ErrorLine error={listing.error === "disconnected" ? "Brigadier isn't running" : listing.error} />
        </li>
      );
    if (!listing.entries.some((entry) => !copied.includes(entry))) return <li className="h-7 text-xs leading-7 text-muted-foreground">No ignored files here.</li>;
    return listing.entries.filter((entry) => !copied.includes(entry)).map((entry) => {
      const folder = entry.endsWith("/");
      const opened = open.includes(entry);
      return (
        <li key={entry} className="flex flex-col">
          <div className={cx("flex h-7 items-center gap-2", depth > 0 && "ps-5")}>
            {folder ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${opened ? "Close" : "Open"} ${entry}`}
                aria-expanded={opened}
                onClick={() => {
                  setOpen(opened ? open.filter((each) => each !== entry) : [...open, entry]);
                  if (!opened && listed[entry] === undefined) load(entry);
                }}
              >
                {opened ? <ChevronDown /> : <ChevronRight />}
              </Button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
              <Checkbox checked={picked(entry) || inPicked(entry)} disabled={inPicked(entry)} onCheckedChange={(on) => toggle(entry, on)} />
              <span className="min-w-0 truncate font-mono text-xs">{depth > 0 ? leaf(entry) + (folder ? "/" : "") : entry}</span>
            </label>
          </div>
          {folder && opened && <ul className={cx("flex flex-col", depth > 0 && "ps-5")}>{rows(entry, depth + 1)}</ul>}
        </li>
      );
    });
  };

  const add = () => {
    const path = bare(typed.trim());
    if (path && !files.includes(path)) onFiles([...files, path]);
    setTyped("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-label font-medium text-foreground">Files to copy</span>
        <span className="text-xs text-muted-foreground">Ignored files put into every new worktree</span>
      </div>
      {copied.length > 0 && (
        <ul aria-label="Copied by .worktreeinclude" className="flex flex-col gap-1 rounded-control bg-fill-subtle px-3 py-2">
          <li className="text-xs text-muted-foreground">Always copied, from the repository's .worktreeinclude</li>
          {copied.map((each) => (
            <li key={each} className="flex items-center gap-2 font-mono text-xs">
              <Check className="size-icon-xs text-muted-foreground" />
              {each}
            </li>
          ))}
        </ul>
      )}
      <ul aria-label="Ignored files" className="flex max-h-56 flex-col overflow-y-auto">
        {rows("", 0)}
        {files
          .filter((each) => !shown.has(each))
          .map((each) => (
            <li key={each} className="flex h-7 items-center gap-2 ps-7">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                <Checkbox checked onCheckedChange={() => toggle(each, false)} />
                <span className="min-w-0 truncate font-mono text-xs">{each}</span>
              </label>
            </li>
          ))}
      </ul>
      <div className="flex items-center gap-1">
        <Input
          value={typed}
          placeholder="Add a path, like config/local.json"
          spellCheck={false}
          aria-label="Add a path"
          className="font-mono"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <Button variant="ghost" size="sm" disabled={!typed.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
