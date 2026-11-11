import { type KeyboardEvent, useRef, useState } from "react";

import { Check, ChevronDown, MagnifyingGlassSmSearch, Terminal } from "../../icons";
import { Button } from "../button";
import { ConfirmForm } from "../confirm-dialog";
import { cx } from "../cx";
import { Dialog, DialogContent } from "../dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Segmented } from "../segmented";
import { ComposerPill } from "./composer";
import { fuzzyMatch, MatchedText } from "./menus";
import { STILL } from "./pickers";

/** A model an agent offers, and the effort levels it takes ("low", "xhigh"…). PROPOSED. */
export type Model = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
  /** Being retired, as its CLI's list says: when (ms) and the model it suggests instead, each null where not said. */
  retiring?: { at: number | null; to: string | null } | null;
};

/**
 * An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). `unavailable`: its CLI
 * isn't installed ("install") or isn't signed in ("sign-in"), so it has no models to show yet. PROPOSED.
 */
export type ModelGroup = { provider: string; label: string; mark: string | null; models: Model[]; unavailable?: "install" | "sign-in" | null };

/** What the session runs on. */
export type ModelChoice = { provider: string; model: string; effort: string | null };

/** "xhigh" → "Extra high", "medium" → "Medium". */
export function effortLabel(effort: string): string {
  const known: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  return known[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** An agent's mark, from its adapter (trusted, built in); without one, a terminal. */
export function ProviderMark({ mark, className }: { mark: string | null; className?: string }) {
  if (!mark) return <Terminal aria-hidden className={className} />;
  // A sized svg: a pill's or row's own `svg:` icon size would otherwise compete with the mark's box.
  const html = mark.replace("<svg", '<svg class="size-full"');
  return <span aria-hidden className={cx("inline-grid shrink-0 place-items-center", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

const SIDEBAR_ROW = cx(
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-icon-button px-2.5 text-start text-label text-toolbar-foreground outline-none",
  "hover:bg-fill focus-visible:bg-fill aria-selected:bg-fill aria-selected:text-foreground",
);
const MODEL_ROW = cx(
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-surface ps-2.5 pe-8 text-start text-sm outline-none",
  "hover:bg-fill focus-visible:bg-fill",
);
const rowsOf = (list: Element | null) => [...(list?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];

/**
 * ↑ ↓ move through a list's rows, ← → between the agents and the models; ↓ from the search goes to the models and ↑
 * from the first model back to it. A letter typed in a list goes to the search.
 */
function moveKeys(event: KeyboardEvent<HTMLDivElement>, search: HTMLInputElement | null, type: (key: string) => void) {
  const target = event.target as HTMLElement;
  const models = event.currentTarget.querySelector("[data-picker-part=models]");
  if (target === search) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    rowsOf(models)[0]?.focus();
    return;
  }
  const here = target.closest<HTMLElement>("[role=listbox]");
  if (!here) return;
  // Space stays the row's own press.
  if ((event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) || event.key === "Backspace") {
    event.preventDefault();
    type(event.key);
    search?.focus();
    return;
  }
  const all = rowsOf(here);
  const at = all.indexOf(target);
  let next: HTMLElement | null | undefined;
  if (event.key === "ArrowDown") next = all[Math.min(at + 1, all.length - 1)];
  else if (event.key === "ArrowUp") next = at <= 0 && here === models ? search : all[Math.max(at - 1, 0)];
  else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const list = rowsOf(event.currentTarget.querySelector(`[data-picker-part=${here.dataset["pickerPart"] === "agents" ? "models" : "agents"}]`));
    next = list.find((row) => row.getAttribute("aria-selected") === "true") ?? list[0];
  } else return;
  event.preventDefault();
  next?.focus();
}

/**
 * The model pill and its picker, opening upward: a search across every agent on top, then the agents beside the
 * browsed one's models, a check on the one in use, and a footer with its effort levels. It opens on the agent in use
 * with the keyboard in the search; a pick closes it, an effort level keeps it open. While searching, the matches of every agent set up show in
 * one list with their marks, and Enter picks the first; Esc clears the search before it closes the picker. An agent
 * not installed or not signed in is dimmed, and shows what it needs and "Set up" in place of its models.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  onSetUp,
  disabled,
  held,
  search: typed = "",
  asksSwitch = true,
  asked = 0,
}: {
  groups: ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Installs or signs in the agent; without it, no "Set up" button. */
  onSetUp?: (provider: string) => void;
  disabled?: boolean;
  /** The gallery's box to hold it open in, not taking focus. */
  held?: HTMLElement;
  /** The gallery's search, already typed. */
  search?: string;
  /** False before a session exists: another agent is then just a pick, with nothing to hand off. */
  asksSwitch?: boolean;
  /** A count that opens it each time it goes up: a notice's "Choose another model". */
  asked?: number;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(asked);
  if (asked !== seen) {
    setSeen(asked);
    if (!disabled) setOpen(true);
  }
  const [browsing, setBrowsing] = useState(value.provider);
  const [query, setQuery] = useState(typed);
  const [inSearch, setInSearch] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const group = groups.find((entry) => entry.provider === browsing) ?? groups[0];
  const current = groups.find((entry) => entry.provider === value.provider);
  const model = current?.models.find((entry) => entry.id === value.model);
  const needle = query.trim();
  // Every set-up agent's models that match, best match first, in agent order within each.
  const matches = needle
    ? groups
        .filter((entry) => !entry.unavailable)
        .flatMap((entry) => entry.models.map((each) => ({ group: entry, model: each, rank: fuzzyMatch(each.name, needle)?.rank })))
        .filter((row) => row.rank !== undefined)
        .toSorted((a, b) => a.rank! - b.rank!)
    : null;
  const first = matches?.[0];
  // A new model keeps the effort when it has that level, else takes its own default.
  // Another agent's model is a switch (Rust starts a new conversation with a hand-off): asked first.
  const [switching, setSwitching] = useState<ModelChoice | null>(null);
  const pick = (provider: string, next: Model) => {
    const choice = {
      provider,
      model: next.id,
      effort: value.effort && next.efforts.includes(value.effort) ? value.effort : (next.defaultEffort ?? next.efforts[0] ?? null),
    };
    setOpen(false);
    if (provider === value.provider || !asksSwitch) onChange(choice);
    else setSwitching(choice);
  };
  const modelRow = (provider: string, entry: Model, mark?: { mark: string | null; label: string }) => {
    const checked = provider === value.provider && entry.id === value.model;
    return (
      <button
        key={`${provider}:${entry.id}`}
        type="button"
        role="option"
        aria-selected={checked}
        onClick={() => pick(provider, entry)}
        // While the search has the keyboard, the first match is the one Enter picks.
        className={cx(MODEL_ROW, inSearch && entry === first?.model && "bg-fill")}
      >
        {mark && <ProviderMark mark={mark.mark} className="size-icon-md" />}
        <span className="min-w-0 truncate">
          {mark ? <MatchedText text={entry.name} query={needle} /> : entry.name}
          {mark && <span className="sr-only">, {mark.label}</span>}
        </span>
        {checked && <Check aria-hidden className="size-icon-sm shrink-0" />}
      </button>
    );
  };
  return (
    <>
      <Popover
        open={held ? true : open}
        onOpenChange={(next, details) => {
          if (!next && details.reason === "escape-key" && query) {
            details.cancel();
            setQuery("");
            search.current?.focus();
            return;
          }
          if (next) {
            setBrowsing(value.provider);
            setQuery("");
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          render={<ComposerPill aria-label={`Model: ${model?.name ?? value.model}${value.effort ? `, ${effortLabel(value.effort)}` : ""}`} data-slot="model-picker-trigger" />}
        >
          {/* The old pill's tighter gap; the pill's own is set in its base. */}
          <span className="flex min-w-0 items-center gap-1">
            <ProviderMark mark={current?.mark ?? null} className="size-icon-sm" />
            <span className="truncate text-foreground">{model?.name ?? value.model}</span>
            {value.effort && <span className="shrink-0">{effortLabel(value.effort)}</span>}
            <ChevronDown className="size-icon-xs" />
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          padded={false}
          aria-label="Model"
          container={held}
          collisionAvoidance={held ? STILL : undefined}
          initialFocus={held ? false : search}
          className="max-w-full overflow-hidden"
        >
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the search's and the lists' keys */}
          <div
            data-slot="model-picker"
            onKeyDown={(event) => moveKeys(event, search.current, (key) => setQuery((now) => (key === "Backspace" ? now.slice(0, -1) : now + key)))}
            className="flex h-model-picker-height max-h-available w-model-picker max-w-full flex-col"
          >
            <label className="flex h-11 shrink-0 items-center gap-2 border-b border-divider px-4">
              <MagnifyingGlassSmSearch aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !first) return;
                  event.preventDefault();
                  pick(first.group.provider, first.model);
                }}
                onFocus={() => setInSearch(true)}
                onBlur={() => setInSearch(false)}
                placeholder="Search every agent"
                aria-label="Search every agent"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div className="flex min-h-0 flex-1">
              {!matches && (
                <>
                  <div role="listbox" aria-label="Agents" data-picker-part="agents" className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5">
                    {groups.map((entry) => (
                      <button
                        key={entry.provider}
                        type="button"
                        role="option"
                        aria-selected={entry.provider === group?.provider}
                        onClick={() => setBrowsing(entry.provider)}
                        className={cx(SIDEBAR_ROW, entry.unavailable && "opacity-disabled")}
                      >
                        <ProviderMark mark={entry.mark} className="size-icon-md" />
                        <span className="min-w-0 truncate">{entry.label}</span>
                        {!entry.unavailable && <span className="ms-auto shrink-0 text-xs text-muted-foreground">{entry.models.length}</span>}
                      </button>
                    ))}
                  </div>
                  <div aria-hidden className="w-px shrink-0 bg-divider" />
                </>
              )}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
                <div
                  role="listbox"
                  aria-label={matches ? "Matching models" : `${group?.label ?? ""} models`}
                  data-picker-part="models"
                  className="flex flex-col gap-0.5"
                >
                  {matches
                    ? matches.map((row) => modelRow(row.group.provider, row.model, row.group))
                    : !group?.unavailable && group?.models.map((entry) => modelRow(group.provider, entry))}
                </div>
                {matches?.length === 0 && <p className="px-2.5 py-1.75 text-xs text-muted-foreground">No models match “{needle}”</p>}
                {!matches && group?.unavailable && (
                  <div data-slot="model-picker-not-set-up" className="flex flex-col items-center gap-2.5 px-5 py-7 text-center">
                    <span className="grid size-8.5 shrink-0 place-items-center rounded-nav border border-divider text-muted-foreground">
                      <ProviderMark mark={group.mark} className="size-4.25" />
                    </span>
                    <p className="text-sm font-medium text-foreground">
                      {group.label} {group.unavailable === "install" ? "isn't installed" : "isn't signed in"}
                    </p>
                    <p className="max-w-72 text-xs text-muted-foreground">
                      {group.unavailable === "install" ? "Install it and its models show here." : "Sign in and its models show here."}
                    </p>
                    {onSetUp && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => {
                          setOpen(false);
                          onSetUp(group.provider);
                        }}
                      >
                        Set up {group.label}
                      </Button>
                    )}
                  </div>
                )}
                {!matches && !group?.unavailable && group?.models.length === 0 && (
                  <p className="px-2.5 py-1.75 text-xs text-muted-foreground">No models listed yet</p>
                )}
              </div>
            </div>
            {/* Hidden when the model has no levels (some agents report none). */}
            {model && model.efforts.length > 0 && (
              <div className="flex h-11 shrink-0 items-center gap-3 border-t border-divider ps-4 pe-2.25">
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  Effort
                  <span className="opacity-75"> · {model.name}</span>
                </div>
                <div className="shrink-0">
                  <Segmented
                    label="Effort"
                    value={value.effort ?? ""}
                    options={model.efforts.map((level) => ({ value: level, label: effortLabel(level) }))}
                    onChange={(level) => onChange({ ...value, effort: level })}
                    fill
                  />
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <SwitchAgentDialog
        to={switching && (groups.find((entry) => entry.provider === switching.provider)?.label ?? switching.provider)}
        onCancel={() => setSwitching(null)}
        onConfirm={() => {
          if (switching) onChange(switching);
          setSwitching(null);
        }}
      />
    </>
  );
}

/**
 * "Switch to X?": the chat goes on with another agent, as a new conversation it hands what's done to. `fork`: the
 * same confirm with Fork's words, naming the agent before the conversation goes to it [D90, D162, D1071].
 */
export function SwitchAgentDialog({
  to,
  onCancel,
  onConfirm,
  held,
  fork = false,
}: {
  /** The agent's name; null while closed. */
  to: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
  fork?: boolean;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  // Kept while the dialog animates out.
  const [name, setName] = useState(to ?? "");
  if (to !== null && to !== name) setName(to);
  return (
    <Dialog open={to !== null} modal={!held} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent container={held} initialFocus={held ? false : confirm}>
        <ConfirmForm
          title={fork ? `Fork to ${name}?` : `Switch to ${name}?`}
          description={
            fork
              ? `The fork goes on with ${name} in a new conversation, and it gets everything up to this answer.`
              : `The chat goes on with ${name} in a new conversation, and it gets everything so far, so nothing is lost.`
          }
          confirm={fork ? "Fork" : "Switch"}
          onCancel={onCancel}
          onConfirm={onConfirm}
          confirmRef={confirm}
        />
      </DialogContent>
    </Dialog>
  );
}

