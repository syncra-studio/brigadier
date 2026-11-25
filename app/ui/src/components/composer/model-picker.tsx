import { type ComponentProps, type HTMLAttributes, type ReactElement, type RefObject, useState } from "react";

import { Bolt, Terminal } from "../../icons";
import { cx } from "../cx";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { ModelColumns } from "./model-columns";
import { named, useClosesOnTyping } from "./model-keys";
import type { Quota } from "./quota-lines";

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
  /** Whether it makes and edits images with a tool of its own, where its CLI says [D298]. */
  draws?: boolean | null;
  /** What its fast tier offers, where it has one: the Fast switch's tip. */
  fast?: string | null;
  /** An older model its CLI still offers beside a newer one: it waits behind Show more. */
  legacy?: boolean;
};

/**
 * An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). `unavailable`: its CLI
 * isn't installed ("install") or isn't signed in ("sign-in"), so it has no models to show yet. PROPOSED.
 */
export type ModelGroup = {
  provider: string;
  label: string;
  /** The short name it goes by ("Claude" for "Claude Code"). */
  short?: string | null;
  mark: string | null;
  models: Model[];
  unavailable?: "install" | "sign-in" | null;
  /** Each signed-in account's limits, where Rust serves them [D337]. */
  usage?: Quota[] | null;
};

/** What the session runs on; `fast` on its model's fast tier. */
export type ModelChoice = { provider: string; model: string; effort: string | null; fast?: boolean };

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
export function ModelLabel({ groups, value, efforts = true, mark = "size-icon-md" }: { groups: ModelGroup[]; value: ModelChoice; efforts?: boolean; mark?: string }) {
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
export function modelWords(groups: ModelGroup[], value: ModelChoice): string {
  const model = groups.find((entry) => entry.provider === value.provider)?.models.find((entry) => entry.id === value.model);
  const word = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  return `Model: ${named(groups, value.provider, value.model)}${value.fast === true && model?.fast ? ", Fast" : ""}${word ? `, ${word}` : ""}`;
}

export type PickerProps = {
  groups: ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Installs or signs in the agent; without it, no "Set up" button. */
  onSetUp?: (provider: string) => void;
  /** False before a session exists: another agent is then just a pick, with nothing to hand off. */
  asksSwitch?: boolean;
  /** False for a setting that takes no effort level or speed: no effort column and no Fast. */
  efforts?: boolean;
};

/**
 * The model picker, one menu everywhere [D89, D91]: in the menus' material at its `trigger` (the composer's pill, a
 * settings row's select) or its `anchor`, flipping near the window's edge. Esc, a click outside and a pick close it.
 */
export function ModelPicker({
  disabled,
  asked = 0,
  trigger,
  anchor,
  side = "bottom",
  align = "start",
  finalFocus,
  onClose,
  ...columns
}: PickerProps &
  Pick<ComponentProps<typeof PopoverContent>, "side" | "align" | "finalFocus"> & {
    disabled?: boolean;
    /** A count that opens it each time it goes up (Fork's "Fork with another agent", a notice's "Choose another model"). */
    asked?: number;
    /** Its trigger, shown with the model it holds. */
    trigger?: (props: HTMLAttributes<HTMLElement>) => ReactElement;
    /** No trigger: it opens by `asked`, under this element (the fork menu's button), where its menu was [D177]. */
    anchor?: RefObject<Element | null>;
    /** As it closes; `cancelled` when by Escape or Set up. */
    onClose?: (cancelled: boolean) => void;
  }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(asked);
  if (asked !== seen) {
    setSeen(asked);
    if (!disabled) setOpen(true);
  }
  if (open && disabled) setOpen(false);
  const close = (cancelled = false) => {
    setOpen(false);
    onClose?.(cancelled);
  };
  useClosesOnTyping(open, close);
  const { groups, value, efforts, onSetUp } = columns;
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // The Switch confirm takes the focus without closing it.
        if (details.reason === "focus-out") return;
        if (next) setOpen(true);
        else close(details.reason === "escape-key");
      }}
    >
      {trigger && (
        <PopoverTrigger disabled={disabled} render={trigger}>
          <ModelLabel groups={groups} value={value} efforts={efforts} mark="size-icon-sm" />
        </PopoverTrigger>
      )}
      <PopoverContent
        side={side}
        align={align}
        anchor={anchor}
        padded={false}
        aria-label="Model"
        data-slot="model-popover"
        initialFocus={() => document.querySelector<HTMLElement>("[data-slot=model-picker] input")}
        finalFocus={finalFocus}
      >
        <ModelColumns
          {...columns}
          close={close}
          onSetUp={
            onSetUp &&
            ((provider) => {
              close(true);
              onSetUp(provider);
            })
          }
        />
      </PopoverContent>
    </Popover>
  );
}
