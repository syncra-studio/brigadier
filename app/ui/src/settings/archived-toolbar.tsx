import { useRef } from "react";

import { Button } from "../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/menu";
import { Select, SelectTrigger } from "../components/select";
import { Check, DotsHorizontal, Filter, Folder, MagnifyingGlassSearch, Trash, XCircleFilled } from "../icons";

/** What the Archived page asks Rust for; Rust filters, sorts and groups. */
export type ArchivedFilter = {
  query: string;
  kind: "all" | "session" | "chat";
  /** "all", "chats" or a project's id. */
  project: string;
  order: "updated" | "created" | "alphabetical";
};

const KIND_CHOICES = [
  { value: "all", label: "All chats" },
  { value: "session", label: "Sessions" },
  { value: "chat", label: "Chats" },
] as const;

const ORDER_CHOICES = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "alphabetical", label: "Alphabetical" },
] as const;

/** The old Settings search pill: a magnifier, the field, a clear button; Esc empties it. */
export function SearchField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  return (
    <label className="flex h-control-md min-w-0 flex-1 items-center gap-2 rounded-capsule border border-fill-active bg-fill px-2.5 has-focus-visible:focus-ring">
      <MagnifyingGlassSearch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
      <input
        ref={field}
        value={value}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-faint-foreground"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !value) return;
          event.stopPropagation();
          onChange("");
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          className="flex shrink-0 cursor-pointer items-center rounded-capsule text-faint-foreground hover:text-foreground focus-visible:focus-ring"
          onClick={() => {
            onChange("");
            field.current?.focus();
          }}
        >
          <XCircleFilled className="size-icon-sm" />
        </button>
      )}
    </label>
  );
}

const check = <Check className="size-icon-md" />;

/** Which kind shows (all, sessions, chats) and in what order. */
export function KindMenu({ filter, onChange }: { filter: ArchivedFilter; onChange: (next: Partial<ArchivedFilter>) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <SelectTrigger label="Filter archived chats" icon={<Filter aria-hidden className="size-icon-sm shrink-0" />} className="w-40">
            {KIND_CHOICES.find((choice) => choice.value === filter.kind)?.label}
          </SelectTrigger>
        }
      />
      <DropdownMenuContent align="end" className="w-anchor">
        <DropdownMenuLabel>Type</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={filter.kind} onValueChange={(kind) => onChange({ kind })}>
          {KIND_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} indicator={check}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={filter.order} onValueChange={(order) => onChange({ order })}>
          {ORDER_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} indicator={check}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which project's sessions show, or the chats: Rust's choices. */
export function ProjectMenu({ value, choices, onChange }: { value: string; choices: { value: string; label: string }[]; onChange: (project: string) => void }) {
  return (
    <Select
      label="Filter archived chats by project"
      value={value}
      options={choices}
      onChange={onChange}
      icon={<Folder aria-hidden className="size-icon-sm shrink-0" />}
      className="w-40"
    />
  );
}

/** "…": Delete all (of what shows). */
export function MoreMenu({ count, narrowed, onDeleteAll }: { count: number; narrowed: boolean; onDeleteAll: () => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" className="text-quiet-foreground" />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" disabled={count === 0} onClick={onDeleteAll}>
          <Trash />
          {narrowed ? `Delete these ${count}…` : "Delete all…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
