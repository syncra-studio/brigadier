import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { ComposerPill } from "../components/composer/composer";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, itemClasses, MenuRow } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { run } from "../onboarding/api";
import { BranchAlt, Check, Desktop, Folder, MagnifyingGlassSmSearch, Plus, X } from "../icons";

/*
 * The draft's utility bar pills [D160, D161, D388], as the old app's: ghost pills in bright text that open upward,
 * the project (a search, the projects by name with ✓, Add project, no project) and where the session works.
 */

export type DraftProject = { id: string; name: string; trusted?: boolean | null; kind?: "folder"; folder?: string };
/** Where a new session works: its own worktree (the default), the project's own folder, or another worktree of it [D160, D388]. */
export type WorkIn = "worktree" | "local" | "existing";

/** A rail pill: the composer's pill in the rail's bright text. */
export const RAIL_PILL = "max-w-80 text-foreground";

/** The rail's row of pills. It scrolls sideways, fading at the edge, when the composer is too narrow. */
export function UtilityBar({ className, children }: { className?: string; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const measure = () => {
    const element = bar.current;
    if (element) setOverflowing(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
  };
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(bar.current!);
    observer.observe(bar.current!.firstElementChild!);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={bar} onScroll={measure} data-overflowing={overflowing || undefined} className={cx("hide-scrollbar overflow-x-auto px-1 py-1.25 data-overflowing:mask-fade-end", className)}>
      <div className="flex w-max items-center gap-2">{children}</div>
    </div>
  );
}

/** A folder of repos' count, in place of where a session works and on what branch: each chat claims its own [D494]. */
export function RepoCount({ folder }: { folder: string }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    run(["projects", "inspect", folder]).then((reply) => live && setCount(reply.check?.repos?.length ?? null), () => undefined);
    return () => {
      live = false;
    };
  }, [folder]);
  return count !== null && <span className="shrink-0 text-sm text-muted-foreground">{count} repos</span>;
}

/** A picker's search field. */
export function PickerSearch({ list, label, value, onChange, onKeyDown }: { list: string; label: string; value: string; onChange: (query: string) => void; onKeyDown?: (event: KeyboardEvent) => void }) {
  return (
    <label className="mb-1 flex h-control-sm items-center gap-2 rounded-capsule px-2 ring ring-border">
      <MagnifyingGlassSmSearch aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded
        aria-controls={list}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

// A typed path is a folder to add: "Add ~/code/app".
const asPath = (query: string) => (/^(~|\/)/.test(query.trim()) ? query.trim() : "");

/**
 * The project picker. With `heading` its trigger is the hero's dotted-underline name, opening below it; otherwise
 * the rail pill ("Choose project" with none). ↑/↓ move over the rows, Enter picks.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  onAdd,
  onNone,
  heading = false,
}: {
  projects: readonly DraftProject[];
  value: DraftProject | null;
  onChange: (id: string) => void;
  /** Opens Add project, on a typed folder if any. */
  onAdd: (path: string) => void;
  /** "Don't work in a project": the draft becomes a chat. */
  onNone?: () => void;
  heading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useId();
  const needle = query.trim().toLowerCase();
  const path = asPath(query);
  const shown = projects.toSorted((a, b) => a.name.localeCompare(b.name)).filter((each) => each.name.toLowerCase().includes(needle));
  const none = value && onNone;
  // The projects, then Add project, then no project.
  const count = shown.length + (none ? 2 : 1);
  const highlighted = Math.min(at, count - 1);
  const pick = (index: number) => {
    setOpen(false);
    if (index < shown.length) onChange(shown[index]!.id);
    else if (index === shown.length) onAdd(path);
    else onNone?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      setAt((highlighted + step + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(highlighted);
    }
  };
  const row = (index: number, content: ReactElement, selected?: boolean) => (
    <button
      key={index}
      type="button"
      role="option"
      aria-selected={selected}
      data-highlighted={index === highlighted || undefined}
      onPointerMove={() => setAt(index)}
      onClick={() => pick(index)}
      className={cx(itemClasses, "w-full text-start")}
    >
      {content}
    </button>
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setAt(0);
      }}
    >
      <PopoverTrigger
        render={
          heading ? (
            <button type="button" aria-label="Project" className="cursor-pointer underline decoration-muted-foreground decoration-dotted underline-offset-link transition-colors hover:text-muted-foreground focus-visible:focus-ring" />
          ) : (
            <ComposerPill aria-label="Project" title={value ? "Change the project for this session" : "Choose a project to start a session in"} className={RAIL_PILL} />
          )
        }
      >
        {heading ? (
          value?.name
        ) : (
          <>
            <Folder />
            <span className="truncate">{value?.name ?? "Choose project"}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        side={heading ? "bottom" : "top"}
        align={heading ? "center" : "start"}
        className="w-80 max-w-full"
      >
        <PickerSearch
          list={list}
          label="Search projects"
          value={query}
          onChange={(next) => {
            setQuery(next);
            setAt(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id={list} role="listbox" aria-label="Projects" className="max-h-command-list overflow-y-auto">
          {shown.map((each, index) => row(index, <MenuRow icon={<Folder />} title={each.name} hint={each.id === value?.id && <Check aria-hidden />} />, each.id === value?.id))}
        </div>
        {shown.length === 0 && !path && <p className="px-2 py-1.5 text-sm text-muted-foreground">{projects.length === 0 ? "No projects yet" : "No projects match"}</p>}
        <div className="mt-1 border-t border-divider pt-1">
          {row(shown.length, <MenuRow icon={<Plus />} title={path ? `Add ${path}` : "Add project"} />)}
          {none && row(shown.length + 1, <MenuRow icon={<X />} title="Don't work in a project" />)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const PLACES: Record<WorkIn, { label: string; Icon: typeof Folder }> = {
  worktree: { label: "New worktree", Icon: BranchAlt },
  local: { label: "Local checkout", Icon: Desktop },
  existing: { label: "Existing worktree", Icon: Folder },
};

/** The "Work in" menu: a new worktree (the default), the project's own checkout or another worktree, each with the old tooltip. */
export function WorkInPicker({ value, onChange, repo }: { value: WorkIn; onChange: (next: WorkIn) => void; repo: string }) {
  const tips: Record<WorkIn, string> = {
    worktree: `Create a copy of ${repo} to work in parallel.`,
    local: `Work in ${repo} itself, on the branch it has checked out.`,
    existing: `Work in another worktree of ${repo}, on its branch.`,
  };
  const { label, Icon } = PLACES[value];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<ComposerPill aria-label={`Work in: ${label}`} title={tips[value]} className={RAIL_PILL} />}>
        <Icon />
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72 max-w-full">
        <DropdownMenuLabel variant="heading">Work in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(next: WorkIn) => onChange(next)}>
          {(Object.keys(PLACES) as WorkIn[]).map((place) => {
            const { label: name, Icon: PlaceIcon } = PLACES[place];
            return (
              <DropdownMenuRadioItem key={place} value={place} title={tips[place]} indicator={<Check className="size-icon-md" />}>
                <PlaceIcon />
                {name}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
