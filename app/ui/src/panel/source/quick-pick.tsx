import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../../components/cx";
import { Input } from "../../components/input";
import { Popover, PopoverContent } from "../../components/popover";
import { Branch as BranchIcon, Plus } from "../../icons";
import type { Branch } from "../types";
import { ago } from "../words";

/** One row of a quick pick: its icon and title, a grey hint after it and a note at its end, a second line, a rule above it. */
export type PickItem = { id: string; icon: ReactNode; title: string; hint?: string; note?: string; detail?: string; rule?: boolean };

/** Where a quick pick or the name box opens: over the branch item it came from; `trigger`, what opens it there. */
export type Place = { anchor: RefObject<Element | null>; trigger?: RefObject<Element | null> };

/**
 * The popover a quick pick or the name box sits on, below the card's branch row [D1205]; a click outside or Escape closes
 * it. A press on its trigger is left to the trigger, which toggles it: closing here first would let that click open it again [D462].
 */
function Surface({ place, onClose, children }: { place: Place; onClose: () => void; children: ReactNode }) {
  return (
    <Popover open onOpenChange={(open, { event }) => !open && !(event.target instanceof Node && place.trigger?.current?.contains(event.target)) && onClose()}>
      <PopoverContent
        anchor={place.anchor}
        side="bottom"
        align="start"
        className="flex max-h-96 w-80 max-w-full flex-col"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A quick pick under the card's branch row (the old BranchPicker): typing narrows it, ↑ ↓ and Enter pick, Escape or a click
 * outside closes it. `items` null while they load. `off`: why nothing can be picked now (the agent is working).
 * `search`: the field that narrows it, only where it lists branches; without it the list keeps the keyboard [D1265].
 */
export function QuickPick({ place, placeholder, items, off = null, search = true, onPick, onClose }: {
  place: Place;
  placeholder: string;
  items: PickItem[] | null;
  off?: string | null;
  search?: boolean;
  onPick?: (item: PickItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (items ?? []).filter((item) => !words || item.title.toLowerCase().includes(words));
  }, [items, query]);
  const picked = Math.min(at, Math.max(0, shown.length - 1));
  // The field keeps the keyboard: the picked row is scrolled to by hand.
  useEffect(() => {
    list.current?.querySelector(`#quick-pick-${picked}`)?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  const choose = (item: PickItem | undefined) => item && !off && onPick?.(item);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") setAt(Math.min(picked + 1, shown.length - 1));
    else if (event.key === "ArrowUp") setAt(Math.max(picked - 1, 0));
    else if (event.key === "Enter") choose(shown[picked]);
    else return;
    event.preventDefault();
  };
  const active = shown[picked] ? `quick-pick-${picked}` : undefined;
  return (
    <Surface place={place} onClose={onClose}>
      {search && (
        <Input
          autoComplete="off"
          spellCheck={false}
          value={query}
          aria-label={placeholder}
          aria-controls="quick-pick-list"
          aria-activedescendant={active}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setAt(0);
          }}
          onKeyDown={keys}
          className="shrink-0"
        />
      )}
      {off && <p className="px-2 pt-1.5 text-xs text-muted-foreground">{off}</p>}
      <div
        ref={list}
        id="quick-pick-list"
        role="listbox"
        aria-label={placeholder}
        aria-disabled={off !== null || undefined}
        {...(!search && { tabIndex: 0, "aria-activedescendant": active, onKeyDown: keys })}
        className="min-h-0 overflow-x-hidden overflow-y-auto outline-none"
      >
        {items === null && <p className="px-2 py-1 text-sm text-muted-foreground">Loading…</p>}
        {items !== null && shown.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">No matching branches</p>}
        {shown.map((item, index) => (
          <div key={item.id}>
            {item.rule && index > 0 && <div className="-mx-1 my-1 h-px bg-border" />}
            <div
              id={`quick-pick-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === picked}
              aria-disabled={off !== null || undefined}
              onPointerMove={() => setAt(index)}
              onClick={() => choose(item)}
              className={cx(
                "mt-1 flex cursor-pointer flex-col rounded-control px-2 py-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-disabled",
                index === picked && "bg-muted",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                <span className="flex shrink-0 text-muted-foreground svg:size-icon-sm">{item.icon}</span>
                {/* The name gives way last: the time and the group's label truncate first. */}
                <span className="max-w-full shrink-0 truncate">{item.title}</span>
                {item.hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{item.hint}</span>}
                <span className="flex-1" />
                {item.note && <span className="min-w-0 truncate text-xs text-muted-foreground">{item.note}</span>}
              </span>
              {item.detail && <span className="truncate text-xs text-muted-foreground">{item.detail}</span>}
            </div>
          </div>
        ))}
      </div>
    </Surface>
  );
}

/**
 * The user's own folder's quick pick, VS Code's: create, create from, then its branches and remote branches, each
 * newest first, the first of each group labelled (the old BranchPicker's rows).
 */
export function folderItems(branches: Branch[] | null, current: string | null, nowMs: number): PickItem[] | null {
  if (!branches) return null;
  const listed = branches
    .filter((branch) => branch.remote || branch.name !== current)
    .sort((a, b) => Number(a.remote) - Number(b.remote) || b.atMs - a.atMs);
  return [
    { id: "create", icon: <Plus />, title: "Create new branch…" },
    { id: "createFrom", icon: <Plus />, title: "Create new branch from…" },
    ...listed.map((branch, index) => ({
      id: `${branch.remote}:${branch.name}`,
      icon: <BranchIcon />,
      title: branch.name,
      hint: ago(branch.atMs, nowMs),
      ...((index === 0 || listed[index - 1]!.remote !== branch.remote) && { note: branch.remote ? "remote branches" : "branches" }),
      detail: `${branch.author} • ${branch.subject}`,
      rule: index === 0,
    })),
  ];
}

/** The name box in the quick pick's place: Create's new branch name. Enter takes it, Escape closes it. */
export function BranchNameBox({ place, placeholder, hint, onName, onClose }: {
  place: Place;
  placeholder: string;
  /** What Enter does, under the field. */
  hint: string;
  onName?: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <Surface place={place} onClose={onClose}>
      <Input
        autoComplete="off"
        spellCheck={false}
        value={name}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // Enter that ends an input method's composition only ends it.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter" && name.trim()) onName?.(name.trim());
          else return;
          event.preventDefault();
        }}
        className="shrink-0"
      />
      <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{hint}</p>
    </Surface>
  );
}
