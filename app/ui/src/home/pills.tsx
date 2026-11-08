import { type KeyboardEvent, type ReactElement, useId, useState } from "react";

import { ComposerPill } from "../components/composer/composer";
import { STILL } from "../components/composer/pickers";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, itemClasses, MenuRow } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { BranchAlt, Check, Desktop, Folder, MagnifyingGlassSmSearch, Plus } from "../icons";

/*
 * The draft's utility bar pills [D160, D161], as the old app's: ghost pills in bright text that open upward,
 * the project (a search, the projects by name with ✓, Add project) and where the session works.
 */

export type DraftProject = { id: string; name: string };
/** Where a new session works: its own worktree (the default) or the project's own folder [D160]. */
export type WorkIn = "worktree" | "local";

/** A rail pill: the composer's pill in the rail's bright text. */
const RAIL_PILL = "max-w-80 text-foreground";

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
  heading = false,
  held,
}: {
  projects: readonly DraftProject[];
  value: DraftProject | null;
  onChange: (id: string) => void;
  /** Opens Add project, on a typed folder if any. */
  onAdd: (path: string) => void;
  heading?: boolean;
  held?: HTMLElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useId();
  const needle = query.trim().toLowerCase();
  const path = asPath(query);
  const shown = projects.toSorted((a, b) => a.name.localeCompare(b.name)).filter((each) => each.name.toLowerCase().includes(needle));
  // The projects, then Add project.
  const count = shown.length + 1;
  const highlighted = Math.min(at, count - 1);
  const pick = (index: number) => {
    setOpen(false);
    if (index < shown.length) onChange(shown[index]!.id);
    else onAdd(path);
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
      open={held ? true : open}
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
        container={held}
        collisionAvoidance={held ? STILL : undefined}
        initialFocus={held ? false : undefined}
        className="w-80 max-w-full"
      >
        <label className="mb-1 flex h-control-sm items-center gap-2 rounded-capsule px-2 ring ring-border">
          <MagnifyingGlassSmSearch aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setAt(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={list}
            placeholder="Search projects"
            aria-label="Search projects"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div id={list} role="listbox" aria-label="Projects" className="max-h-command-list overflow-y-auto">
          {shown.map((each, index) => row(index, <MenuRow icon={<Folder />} title={each.name} hint={each.id === value?.id && <Check aria-hidden />} />, each.id === value?.id))}
        </div>
        {shown.length === 0 && !path && <p className="px-2 py-1.5 text-sm text-muted-foreground">{projects.length === 0 ? "No projects yet" : "No projects match"}</p>}
        <div className="mt-1 border-t border-divider pt-1">{row(shown.length, <MenuRow icon={<Plus />} title={path ? `Add ${path}` : "Add project"} />)}</div>
      </PopoverContent>
    </Popover>
  );
}

const PLACES: Record<WorkIn, { label: string; Icon: typeof Folder }> = {
  worktree: { label: "New worktree", Icon: BranchAlt },
  local: { label: "Local checkout", Icon: Desktop },
};

/** The "Work in" menu: a new worktree (the default) or the project's own checkout, each with the old tooltip. */
export function WorkInPicker({ value, onChange, repo, held }: { value: WorkIn; onChange: (next: WorkIn) => void; repo: string; held?: HTMLElement }) {
  const tips: Record<WorkIn, string> = {
    worktree: `Create a copy of ${repo} to work in parallel.`,
    local: `Work in ${repo} itself, on the branch it has checked out.`,
  };
  const { label, Icon } = PLACES[value];
  return (
    <DropdownMenu modal={false} open={held ? true : undefined}>
      <DropdownMenuTrigger render={<ComposerPill aria-label={`Work in: ${label}`} title={tips[value]} className={RAIL_PILL} />}>
        <Icon />
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" container={held} collisionAvoidance={held ? STILL : undefined} className="w-72 max-w-full">
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
