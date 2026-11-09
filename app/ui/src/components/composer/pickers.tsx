import { type KeyboardEvent, useRef, useState } from "react";

import { Check, ChevronDown, Dock, Folder, Globe, HandRaised, ShieldExclamation, ShieldTerminal, Terminal, Warning } from "../../icons";
import { ConfirmForm } from "../confirm-dialog";
import { cx } from "../cx";
import { Dialog, DialogContent } from "../dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Segmented } from "../segmented";
import { ComposerPill } from "./composer";

/** A model an agent offers, and the effort levels it takes ("low", "xhigh"…). PROPOSED. */
export type Model = { id: string; name: string; efforts: string[]; defaultEffort?: string };

/** An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). PROPOSED. */
export type ModelGroup = { provider: string; label: string; mark: string | null; models: Model[] };

/** What the session runs on. */
export type ModelChoice = { provider: string; model: string; effort: string | null };

// A popup held open in the gallery's box never shifts to stay in view.
const STILL = { side: "none", align: "none" } as const;

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
/** ↑ ↓ move through a list's rows, ← → between the agents and the models. */
function moveKeys(event: KeyboardEvent<HTMLDivElement>) {
  const here = (event.target as HTMLElement).closest<HTMLElement>("[role=listbox]");
  if (!here) return;
  const rows = (list: Element | null) => [...(list?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
  const all = rows(here);
  const at = all.indexOf(event.target as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = all[Math.min(at + 1, all.length - 1)];
  else if (event.key === "ArrowUp") next = all[Math.max(at - 1, 0)];
  else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const other = event.currentTarget.querySelector(`[data-picker-part=${here.dataset["pickerPart"] === "agents" ? "models" : "agents"}]`);
    const list = rows(other);
    next = list.find((row) => row.getAttribute("aria-selected") === "true") ?? list[0];
  } else return;
  event.preventDefault();
  next?.focus();
}

/**
 * The model pill and its picker, opening upward: the agents beside the browsed one's models, a check on the
 * one in use, and a footer with its effort levels. It opens on the agent in use; a pick keeps it open.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  disabled,
  held,
}: {
  groups: ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  disabled?: boolean;
  /** The gallery's box to hold it open in, not taking focus. */
  held?: HTMLElement;
}) {
  const [browsing, setBrowsing] = useState(value.provider);
  const group = groups.find((entry) => entry.provider === browsing) ?? groups[0];
  const current = groups.find((entry) => entry.provider === value.provider);
  const model = current?.models.find((entry) => entry.id === value.model);
  // A new model keeps the effort when it has that level, else takes its own default.
  // Another agent's model is a switch (Rust starts a new conversation with a hand-off): asked first.
  const [switching, setSwitching] = useState<ModelChoice | null>(null);
  const pick = (provider: string, next: Model) => {
    const choice = {
      provider,
      model: next.id,
      effort: value.effort && next.efforts.includes(value.effort) ? value.effort : (next.defaultEffort ?? next.efforts[0] ?? null),
    };
    if (provider === value.provider) onChange(choice);
    else setSwitching(choice);
  };
  return (
    <>
      <Popover open={held ? true : undefined} onOpenChange={(open) => open && setBrowsing(value.provider)}>
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
          initialFocus={held ? false : undefined}
          className="max-w-full overflow-hidden"
        >
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the lists' arrow keys */}
          <div data-slot="model-picker" onKeyDown={moveKeys} className="flex h-model-picker-height max-h-available w-model-picker max-w-full flex-col">
            <div className="flex min-h-0 flex-1">
              <div role="listbox" aria-label="Agents" data-picker-part="agents" className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5">
                {groups.map((entry) => (
                  <button
                    key={entry.provider}
                    type="button"
                    role="option"
                    aria-selected={entry.provider === group?.provider}
                    onClick={() => setBrowsing(entry.provider)}
                    className={SIDEBAR_ROW}
                  >
                    <ProviderMark mark={entry.mark} className="size-icon-md" />
                    <span className="min-w-0 truncate">{entry.label}</span>
                    <span className="ms-auto shrink-0 text-xs text-muted-foreground">{entry.models.length}</span>
                  </button>
                ))}
              </div>
              <div aria-hidden className="w-px shrink-0 bg-divider" />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
                <div role="listbox" aria-label={`${group?.label ?? ""} models`} data-picker-part="models" className="flex flex-col gap-0.5">
                  {group?.models.map((entry) => {
                    const checked = group.provider === value.provider && entry.id === value.model;
                    return (
                      <button key={entry.id} type="button" role="option" aria-selected={checked} onClick={() => pick(group.provider, entry)} className={MODEL_ROW}>
                        <span className="min-w-0 truncate">{entry.name}</span>
                        {checked && <Check aria-hidden className="size-icon-sm shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                {group?.models.length === 0 && <p className="px-2.5 py-1.75 text-xs text-muted-foreground">No models listed yet</p>}
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

/** "Switch to X?": the chat goes on with another agent, as a new conversation it hands what's done to. */
export function SwitchAgentDialog({
  to,
  onCancel,
  onConfirm,
  held,
}: {
  /** The agent's name; null while closed. */
  to: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  // Kept while the dialog animates out.
  const [name, setName] = useState(to ?? "");
  if (to !== null && to !== name) setName(to);
  return (
    <Dialog open={to !== null} modal={!held} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent container={held} initialFocus={held ? false : confirm}>
        <ConfirmForm
          title={`Switch to ${name}?`}
          description={`The chat goes on with ${name} in a new conversation, and it gets everything so far, so nothing is lost.`}
          confirm="Switch"
          onCancel={onCancel}
          onConfirm={onConfirm}
          confirmRef={confirm}
        />
      </DialogContent>
    </Dialog>
  );
}

/** How the agent's actions are approved. The words are the UI's; the level is Rust's. */
export type PermissionLevel = "ask" | "auto" | "full";

const LEVELS: { level: PermissionLevel; label: string; detail: string; Icon: typeof HandRaised }[] = [
  { level: "ask", label: "Ask", detail: "Asks before edits and commands", Icon: HandRaised },
  { level: "auto", label: "Auto", detail: "Works on its own, asks before risky actions", Icon: ShieldTerminal },
  { level: "full", label: "Full access", detail: "Unrestricted access to the internet and all your files", Icon: ShieldExclamation },
];

const ALL_LEVELS = LEVELS.map((each) => each.level);

/**
 * The permission pill and menu, opening upward: "How should the agent's actions be approved?", each level with
 * its icon and one line, a check on the one in use, Full access in orange and confirmed before it turns on. In
 * a folder the user doesn't trust it shows Ask, the only level there, and the others can't be picked.
 */
export function PermissionPicker({
  value: chosen,
  onChange,
  levels = ALL_LEVELS,
  untrusted = false,
  held,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  /** The levels the agent has, from its adapter; one it lacks isn't offered. */
  levels?: readonly PermissionLevel[];
  untrusted?: boolean;
  /** The gallery's box to hold the menu open in. */
  held?: HTMLElement;
}) {
  const [confirming, setConfirming] = useState(false);
  const value = untrusted ? "ask" : chosen;
  const { label, Icon } = LEVELS.find((each) => each.level === value)!;
  return (
    <>
      <DropdownMenu modal={false} open={held ? true : undefined}>
        <DropdownMenuTrigger
          render={
            <ComposerPill
              aria-label={`Permission level: ${label}`}
              data-slot="permission-picker"
              className="max-w-xs"
            />
          }
        >
          {/* Orange on the parts: the pill's base sets its own text colour. */}
          <Icon className={cx("size-icon-md", value === "full" && "text-full-access")} />
          <span className={cx("truncate", value === "full" && "text-full-access")}>{label}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          data-slot="permission-menu"
          container={held}
          collisionAvoidance={held ? STILL : undefined}
          className="w-125 max-w-full p-1.5"
        >
          <p className="px-2 pt-1 pb-1.5 text-sm text-muted-foreground">How should the agent’s actions be approved?</p>
          {untrusted && (
            // As wide as the menu, never widening it.
            <p className="w-0 min-w-full px-2 pb-1.5 text-xs text-muted-foreground">
              This folder isn't trusted, so sessions here ask first. Change it in the project's settings.
            </p>
          )}
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next: PermissionLevel) => {
              if (next === "full" && value !== "full") setConfirming(true);
              else onChange(next);
            }}
          >
            {LEVELS.filter((each) => levels.includes(each.level)).map(({ level, label: name, detail, Icon: LevelIcon }) => {
              const orange = level === "full";
              return (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  disabled={untrusted && level !== "ask"}
                  indicator={<Check className="size-icon-md" />}
                  className={cx("py-1.5", orange && "text-full-access")}
                >
                  {/* The old row's wider gap; the item's own is set in its base. */}
                  <span className="flex min-w-0 items-center gap-3">
                    <LevelIcon className="size-icon-md" />
                    <span className="flex min-w-0 flex-col">
                      <span>{name}</span>
                      <span className={cx("whitespace-nowrap", orange ? "text-full-access" : "text-muted-foreground")}>{detail}</span>
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <FullAccessDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onChange("full");
        }}
      />
    </>
  );
}

/** What Full Access reaches. */
const REACHES = [
  { Icon: Folder, label: "Files" },
  { Icon: Dock, label: "Commands" },
  { Icon: Globe, label: "Internet" },
];

/** "Turn on Full Access?" in one sentence and what it reaches (D172). Only Confirm changes the level; Cancel takes the focus. */
export function FullAccessDialog({
  open,
  onCancel,
  onConfirm,
  held,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} modal={!held} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false} container={held} initialFocus={held ? false : cancel}>
        <ConfirmForm
          title={
            <span className="flex items-center gap-2">
              <Warning className="size-icon-md" />
              Turn on Full Access?
            </span>
          }
          description="Agents can use all of these without asking."
          confirm="Turn on Full Access"
          destructive
          cancelRef={cancel}
          onCancel={onCancel}
          onConfirm={onConfirm}
        >
          <ul className="flex gap-4 text-sm text-muted-foreground">
            {REACHES.map(({ Icon, label }) => (
              <li key={label} className="flex items-center gap-1.5">
                <Icon className="size-icon-sm" />
                {label}
              </li>
            ))}
          </ul>
        </ConfirmForm>
      </DialogContent>
    </Dialog>
  );
}
