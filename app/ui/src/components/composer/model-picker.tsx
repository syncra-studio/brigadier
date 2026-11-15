import { Popover as BasePopover } from "@base-ui/react/popover";
import { type HTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import { Bolt, Terminal } from "../../icons";
import { cx } from "../cx";
import { spacingPx, Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { moveKeys, named, useClosesOnTyping } from "./model-keys";
import { SwitchAgentDialog } from "./switch-agent";

/** A model an agent offers, and the effort levels it takes ("low", "xhigh"…). PROPOSED. */
export type Model = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
  /** Being retired, as its CLI's list says: when (ms) and the model it suggests instead, each null where not said. */
  retiring?: { at: number | null; to: string | null } | null;
  /** Whether it takes images, where its CLI says; unknown counts as yes [D2022 #14]. */
  images?: boolean | null;
  /** What its fast tier offers, where it has one: the Fast key's tip. */
  fast?: string | null;
  /** An older model its CLI still offers beside a newer one: its chip comes after the others. */
  legacy?: boolean;
};

/**
 * An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). `unavailable`: its CLI
 * isn't installed ("install") or isn't signed in ("sign-in"), so it has no models to show yet. PROPOSED.
 */
export type ModelGroup = {
  provider: string;
  label: string;
  /** The short name the shelf's head shows it by ("Claude" for "Claude Code"). */
  short?: string | null;
  mark: string | null;
  models: Model[];
  unavailable?: "install" | "sign-in" | null;
};

/** What the session runs on; `fast` on its model's fast tier. */
export type ModelChoice = { provider: string; model: string; effort: string | null; fast?: boolean };

/** A setting Brigadier may pick for: a chip at the head of the models, and picking a model turns it off [D91]. */
export type Automatic = { chosen: boolean; label: string; hint: string; onChoose: () => void };

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

/** What the pill and a select show: mark, model, ⚡ while on Fast, effort (muted) [D84, D89]. */
export function ModelLabel({ groups, value, automatic, efforts = true, mark = "size-icon-md" }: { groups: ModelGroup[]; value: ModelChoice; automatic?: Automatic; efforts?: boolean; mark?: string }) {
  if (automatic?.chosen) return <span className="truncate text-foreground">{automatic.label}</span>;
  const group = groups.find((entry) => entry.provider === value.provider);
  const model = group?.models.find((entry) => entry.id === value.model);
  const word = !efforts ? null : value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ProviderMark mark={group?.mark ?? null} className={mark} />
      <span className="truncate text-foreground">{named(groups, value.provider, value.model)}</span>
      {value.fast === true && model?.fast && <Bolt aria-hidden className="size-icon-xs shrink-0 text-glyph-5" />}
      {word && <span className="shrink-0 text-muted-foreground">{word}</span>}
    </span>
  );
}

/** Its words for a screen reader: "Model: GPT-5.5, Fast, High". */
export function modelWords(groups: ModelGroup[], value: ModelChoice, automatic?: Automatic): string {
  if (automatic?.chosen) return `Model: ${automatic.label}`;
  const model = groups.find((entry) => entry.provider === value.provider)?.models.find((entry) => entry.id === value.model);
  const word = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  return `Model: ${named(groups, value.provider, value.model)}${value.fast === true && model?.fast ? ", Fast" : ""}${word ? `, ${word}` : ""}`;
}

function Tip({ tip, children }: { tip: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

const CHIP = cx(
  "flex h-control-sm shrink-0 cursor-pointer items-center rounded-capsule border border-glass-stroke px-3 text-label whitespace-nowrap outline-none",
  "transition-colors focus-visible:focus-ring aria-pressed:bg-selection aria-pressed:font-medium aria-pressed:text-foreground",
  "bg-control text-muted-foreground hover:text-foreground",
);
const RULE = <div aria-hidden className="w-px shrink-0 self-stretch bg-divider" />;

/** Effort levels from least to most, as the CLIs list them. */
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export type ShelfProps = {
  groups: ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Installs or signs in the agent; without it, no "Set up" button. */
  onSetUp?: (provider: string) => void;
  /** False before a session exists: another agent is then just a pick, with nothing to hand off. */
  asksSwitch?: boolean;
  automatic?: Automatic;
  /** False for a setting that takes no effort level or speed: no effort scale and no Fast key. */
  efforts?: boolean;
};

/**
 * The model picker's contents, one for the composer's strip and the popover [D84, D89, D91]: the CLIs' marks (columns
 * of five, scrolling sideways past ten), the browsed CLI's models as chips (scrolling under a fade past the shelf's one
 * height), a vertical effort scale and the Fast key, greyed for a model without a fast tier. A pick keeps it open. The
 * scale and key follow the chip under the keyboard, else the one in use; a level or Fast of a model not picked yet
 * picks it so. A CLI not installed or not signed in is dimmed, and says so with Set up in place of its models. Another
 * CLI's model asks "Switch to X?" first. `onEnter` and `onEscape`: the strip's keys that fold it; `onLeave`: Set up.
 */
export function ModelShelf({ groups, value, onChange, onSetUp, asksSwitch = true, automatic, efforts = true, onEnter, onEscape, onLeave }: ShelfProps & { onEnter?: () => void; onEscape?: () => void; onLeave?: () => void }) {
  const auto = automatic?.chosen === true;
  const [browsing, setBrowsing] = useState(() => (auto ? (groups.find((entry) => !entry.unavailable) ?? groups[0])?.provider : value.provider));
  const group = groups.find((entry) => entry.provider === browsing) ?? groups[0];
  const [underKeys, setUnderKeys] = useState<{ provider: string; model: Model } | null>(null);
  const [switching, setSwitching] = useState<ModelChoice | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  // It opens with the keyboard on the chip in use (else the first).
  useEffect(() => root.current?.querySelector<HTMLElement>("[data-picker-part=models] [tabindex='0']")?.focus(), []);

  const isChecked = (provider: string, entry: Model) => !auto && provider === value.provider && entry.id === value.model;
  const pick = (provider: string, next: Model, also?: { effort?: string; fast?: boolean }) => {
    const same = provider === value.provider;
    // A new model keeps the effort within the agent when it has that level, else takes its own default; fast carries
    // over to a model with a fast tier too.
    const kept = same && value.effort && next.efforts.includes(value.effort) ? value.effort : (next.defaultEffort ?? null);
    const fast = Boolean(next.fast) && (also?.fast ?? value.fast === true);
    const choice = { provider, model: next.id, effort: also?.effort ?? kept, ...(fast ? { fast } : {}) };
    if (same || !asksSwitch) onChange(choice);
    else setSwitching(choice);
  };

  const models = group && !group.unavailable ? [...group.models.filter((each) => !each.legacy), ...group.models.filter((each) => each.legacy)] : [];
  const shown = group && models.some((each) => isChecked(group.provider, each));
  // The scale's model: the chip under the keyboard (of the CLI browsed: another's chip left without a blur), else the
  // one in use when its CLI is the one browsed.
  const inHand = (underKeys?.provider === group?.provider ? underKeys?.model : null) ?? (shown ? models.find((each) => isChecked(group!.provider, each)) : null) ?? null;
  const inHandChecked = Boolean(group && inHand && isChecked(group.provider, inHand));
  // Every level the CLI's models take, highest on top: known ones in their order, another just above the one its list
  // puts before it ("ultra" over "max").
  const rankOf = (level: string) => {
    if (LEVELS.includes(level)) return LEVELS.indexOf(level);
    const list = models.find((each) => each.efforts.includes(level))!.efforts;
    return LEVELS.indexOf(list[list.indexOf(level) - 1] ?? "") + 0.5;
  };
  const levels = [...new Set(models.flatMap((each) => each.efforts))].toSorted((a, b) => rankOf(b) - rankOf(a));
  const fastOn = inHandChecked && value.fast === true;
  const act = (also: { effort?: string; fast?: boolean }) => {
    if (!group || !inHand) return;
    if (inHandChecked) onChange({ ...value, ...also });
    else pick(group.provider, inHand, also);
  };
  // Leaving a chip for the scale or the key keeps the model they act on.
  const keeps = (to: EventTarget | null) => to instanceof Node && Boolean(side.current?.contains(to));
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (moveKeys(event)) return;
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    } else if (event.key === "Enter" && onEnter && (event.target as HTMLElement).closest("[data-picker-part]")) onEnter();
  };
  const anyChip = auto || Boolean(shown);
  const chip = (key: string, label: string, pressed: boolean, first: boolean, onClick: () => void, entry?: Model) => (
    <button
      key={key}
      type="button"
      data-picker-item=""
      aria-pressed={pressed}
      tabIndex={pressed || (!anyChip && first) ? 0 : -1}
      onClick={onClick}
      onFocus={() => setUnderKeys(entry && group ? { provider: group.provider, model: entry } : null)}
      onBlur={(event) => !keeps(event.relatedTarget) && setUnderKeys(null)}
      className={CHIP}
    >
      {label}
    </button>
  );

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the parts' arrows, Enter and Esc
    <div ref={root} data-slot="model-picker" onKeyDown={keys} className="flex h-model-picker-height w-full flex-col pt-0.5">
      <div className="flex min-h-0 flex-1 gap-2.5 px-0.5 pt-1">
        <div role="group" aria-label="Agents" data-picker-part="marks" className="grid shrink-0 auto-cols-max grid-flow-col grid-rows-5 content-start gap-0.5 overflow-x-auto hide-scrollbar scroll-edge-fade-x max-w-model-marks">
          {groups.map((entry) => {
            const on = entry.provider === group?.provider;
            return (
              <Tip key={entry.provider} tip={entry.label}>
                <button
                  type="button"
                  data-picker-item=""
                  aria-label={entry.label}
                  aria-pressed={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setBrowsing(entry.provider)}
                  onFocus={() => setBrowsing(entry.provider)}
                  className="grid h-control-sm w-8 cursor-pointer place-items-center rounded-icon-button outline-none hover:bg-fill focus-visible:focus-ring aria-pressed:bg-selection"
                >
                  <ProviderMark mark={entry.mark} className={cx("size-icon-md", entry.unavailable && "opacity-picker-dim")} />
                </button>
              </Tip>
            );
          })}
        </div>
        {RULE}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="shrink-0 text-2xs font-semibold text-placeholder">{group ? (group.short ?? group.label) : "Models"}</div>
          {group?.unavailable ? (
            <div data-slot="model-picker-not-set-up" className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-label text-muted-foreground">
              <span>
                {group.label} {group.unavailable === "install" ? "isn't installed. Install it and its models show here." : "isn't signed in. Sign in and its models show here."}
              </span>
              {onSetUp && (
                <button
                  type="button"
                  aria-label={`Set up ${group.label}`}
                  onClick={() => {
                    onLeave?.();
                    onSetUp(group.provider);
                  }}
                  className="flex h-control-sm shrink-0 cursor-pointer items-center rounded-capsule bg-control px-3 font-medium text-foreground outline-none hover:bg-selection focus-visible:focus-ring"
                >
                  Set up
                </button>
              )}
            </div>
          ) : (
            <div role="group" aria-label={group ? `${group.label} models` : "Models"} data-picker-part="models" className="-m-1 flex min-h-0 flex-wrap content-start gap-x-1.5 gap-y-2 overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
              {automatic && (
                <Tip tip={automatic.hint}>{chip("automatic", automatic.label, auto, true, automatic.onChoose)}</Tip>
              )}
              {group && models.map((entry, index) => chip(entry.id, entry.name, isChecked(group.provider, entry), !automatic && index === 0, () => pick(group.provider, entry), entry))}
              {group && models.length === 0 && <p className="text-xs text-muted-foreground">No models listed yet</p>}
            </div>
          )}
        </div>
        {efforts && RULE}
        {efforts && (
          <div ref={side} className={cx("flex min-h-0 w-26 shrink-0 flex-col gap-2.5", group?.unavailable && "invisible")}>
            {/* Past six levels (OpenCode's), the scale scrolls over the Fast key under a fade. */}
            <div role="radiogroup" aria-label="Effort" data-picker-part="effort" className="flex min-h-0 flex-col overflow-y-auto scroll-edge-fade edge-fade-group">
              <div className="relative flex flex-col">
                {levels.length > 0 && <span aria-hidden className="absolute inset-y-1.5 start-1.25 w-0.5 bg-control" />}
                {levels.map((level, index) => {
                  const takes = Boolean(inHand?.efforts.includes(level));
                  const on = inHandChecked && value.effort === level;
                  const anyOn = inHandChecked && Boolean(value.effort && inHand?.efforts.includes(value.effort));
                  return (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      data-picker-item=""
                      aria-checked={on}
                      disabled={!takes || auto}
                      tabIndex={on || (!anyOn && index === levels.findIndex((each) => inHand?.efforts.includes(each))) ? 0 : -1}
                      title={level === inHand?.defaultEffort ? "Default" : undefined}
                      onClick={() => act({ effort: level })}
                      className="group/step relative flex h-4.5 cursor-pointer items-center gap-1.5 text-start text-xs text-placeholder outline-none focus-visible:focus-ring disabled:cursor-default disabled:opacity-picker-dim aria-checked:font-medium aria-checked:text-foreground"
                    >
                      <span className="grid h-4.5 w-3 shrink-0 place-items-center">
                        <span className="size-1 rounded-full bg-placeholder group-aria-checked/step:size-2.5 group-aria-checked/step:bg-foreground" />
                      </span>
                      {effortLabel(level)}
                    </button>
                  );
                })}
              </div>
            </div>
            {(() => {
              const can = Boolean(inHand?.fast) && !auto;
              const key = (
                <button
                  type="button"
                  aria-pressed={fastOn}
                  aria-disabled={!can}
                  onClick={() => can && act({ fast: !fastOn })}
                  className={cx(
                    "flex h-6.5 w-full shrink-0 items-center justify-center gap-1.25 rounded-capsule border border-glass-stroke text-xs font-medium outline-none focus-visible:focus-ring",
                    fastOn ? "bg-warning-wash text-glyph-5" : "bg-control text-muted-foreground",
                    can ? "cursor-pointer hover:text-foreground" : "cursor-default opacity-picker-none",
                  )}
                >
                  <Bolt aria-hidden className={cx("size-icon-xs", !fastOn && "text-placeholder")} />
                  Fast
                </button>
              );
              return can && inHand?.fast ? <Tip tip={inHand.fast}>{key}</Tip> : key;
            })()}
          </div>
        )}
      </div>
      <SwitchAgentDialog
        to={switching && (groups.find((entry) => entry.provider === switching.provider)?.label ?? switching.provider)}
        onCancel={() => setSwitching(null)}
        onConfirm={() => {
          if (switching) onChange(switching);
          setSwitching(null);
        }}
      />
    </div>
  );
}

/**
 * The model picker wherever there is no composer [D89, D91]: the shelf in the menus' material, 4px under its `trigger`
 * (a settings row's select) or its `anchor`, flipping above near the window's bottom. A pick or Enter keeps it open;
 * Esc or a click outside closes it.
 */
export function ModelPicker({
  disabled,
  asked = 0,
  trigger,
  anchor,
  onClose,
  ...shelf
}: ShelfProps & {
  disabled?: boolean;
  /** A count that opens it each time it goes up (Fork's "Fork with another agent"). */
  asked?: number;
  /** Its trigger (a settings row's select), shown with the model it holds. */
  trigger?: (props: HTMLAttributes<HTMLElement>) => ReactElement;
  /** No trigger: it opens by `asked`, under this element (the fork menu's button), where its menu was [D177]. */
  anchor?: RefObject<Element | null>;
  /** As it closes; `cancelled` when by Escape. */
  onClose?: (cancelled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(asked);
  if (asked !== seen) {
    setSeen(asked);
    if (!disabled) setOpen(true);
  }
  useClosesOnTyping(open, () => (setOpen(false), onClose?.(false)));
  return (
    <BasePopover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next) onClose?.(details.reason === "escape-key");
        setOpen(next);
      }}
    >
      {trigger && (
        <BasePopover.Trigger disabled={disabled} render={trigger}>
          <ModelLabel groups={shelf.groups} value={shelf.value} automatic={shelf.automatic} efforts={shelf.efforts} mark="size-icon-sm" />
        </BasePopover.Trigger>
      )}
      <BasePopover.Portal>
        <BasePopover.Positioner className="z-popup" side="bottom" align="start" sideOffset={spacingPx} anchor={anchor}>
          <BasePopover.Popup
            data-slot="model-popover"
            aria-label="Model"
            initialFocus={false}
            className="w-model-picker max-w-available rounded-surface bg-popover p-1.25 text-foreground shadow-overlay ring ring-popover-edge backdrop-blur-popover outline-none menu-motion"
          >
            <ModelShelf
              {...shelf}
              onLeave={() => {
                setOpen(false);
                onClose?.(true);
              }}
            />
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
