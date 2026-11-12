import { type HTMLAttributes, type ReactElement, useEffect, useRef, useState } from "react";

import { Bolt, Check, ChevronDown, ChevronRight, MagnifyingGlassSmSearch, Sparkles, Star, StarFilled, Terminal } from "../../icons";
import { setStar, useSettings } from "../../settings/api";
import { Button } from "../button";
import { cx } from "../cx";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Segment, SegmentedRoot } from "../segmented";
import { Switch } from "../switch";
import { ComposerPill } from "./composer";
import { fuzzyMatch, MatchedText } from "./menus";
import { focusChoice, moveKeys } from "./model-keys";
import { SwitchAgentDialog } from "./switch-agent";

export { SwitchAgentDialog };

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
  /** What its fast tier offers, where it has one: the footer's Speed picks it. */
  fast?: string | null;
  /** An older model its CLI still offers beside a newer one: under Older models. */
  legacy?: boolean;
};

/**
 * An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). `unavailable`: its CLI
 * isn't installed ("install") or isn't signed in ("sign-in"), so it has no models to show yet. PROPOSED.
 */
export type ModelGroup = {
  provider: string;
  label: string;
  /** The short name the agents column shows it by ("Claude" for "Claude Code"). */
  short?: string | null;
  mark: string | null;
  models: Model[];
  unavailable?: "install" | "sign-in" | null;
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

const SIDEBAR_ROW = cx(
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-icon-button px-2.5 text-start text-label text-shell-foreground outline-none",
  "hover:bg-fill focus-visible:bg-fill aria-selected:bg-fill aria-selected:text-foreground",
);
const MODEL_ROW = cx(
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-surface ps-2.5 pe-8 text-start text-sm outline-none",
  "hover:bg-fill focus-visible:bg-fill",
);
/** One level or speed in the footer: the fill is the chosen one, the ring the keyboard. */
const SEGMENT = cx(
  "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-capsule px-2 text-label whitespace-nowrap text-faint-foreground transition-colors outline-none",
  "hover:text-foreground focus-visible:focus-ring data-pressed:bg-fill-hover data-pressed:text-foreground",
);
const FOOTER_ROW = "flex items-center gap-3 ps-4 pe-2.25";
const FAVORITES = "favorites";
/**
 * The model pill and its picker, opening upward, as the old app's: a search across every agent on top, then the agents
 * beside the browsed one's models (older ones folded under Older models), a check on the one in use, and a footer with
 * the effort levels of the model under the keyboard, else the one in use, and its Speed where it has a fast tier. It
 * opens on the agent in use with the keyboard in the search. A pick keeps it open and takes the keyboard to its levels;
 * a level or speed of a model not picked yet picks it so. While searching, the matches of every agent set up show in one
 * list with their marks, and Enter picks the first; Esc clears the search before it closes the picker. An agent not
 * installed or not signed in is dimmed, and shows what it needs and "Set up" in place of its models. Another agent's
 * model asks "Switch to X?" first, closing the picker. A star on a model's row (shown on hover, kept once set) puts it
 * in Favorites, above the agents, and first in its agent's list; the picker opens on Favorites when the model in use
 * is starred.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  onSetUp,
  disabled,
  asksSwitch = true,
  asked = 0,
  automatic,
  efforts = true,
  trigger,
}: {
  groups: ModelGroup[];
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Installs or signs in the agent; without it, no "Set up" button. */
  onSetUp?: (provider: string) => void;
  disabled?: boolean;
  /** False before a session exists: another agent is then just a pick, with nothing to hand off. */
  asksSwitch?: boolean;
  /** A count that opens it each time it goes up: a notice's "Choose another model". */
  asked?: number;
  /** A setting Brigadier may pick for, as the old app's: a switch over the columns, and picking a model turns it off. */
  automatic?: { chosen: boolean; label: string; hint: string; onChoose: () => void; onTurnOff: () => void };
  /** False for a setting that takes no effort level or speed: no footer. */
  efforts?: boolean;
  /** Its own trigger in place of the composer's pill (a settings row's select). */
  trigger?: (props: HTMLAttributes<HTMLElement>) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(asked);
  const [browsing, setBrowsing] = useState(value.provider);
  const [query, setQuery] = useState("");
  const [inSearch, setInSearch] = useState(false);
  const [older, setOlder] = useState<ReadonlySet<string>>(new Set());
  // The model under the keyboard: the footer follows it.
  const [underKeys, setUnderKeys] = useState<{ provider: string; model: Model } | null>(null);
  const levelsNext = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const starred = useSettings().value?.models_starred ?? [];
  const isStarred = (provider: string, entry: Model) => starred.includes(`${provider}/${entry.id}`);
  const favorites = groups.filter((entry) => !entry.unavailable).flatMap((entry) => entry.models.filter((each) => isStarred(entry.provider, each)).map((each) => ({ group: entry, model: each })));
  const group = browsing === FAVORITES ? undefined : (groups.find((entry) => entry.provider === browsing) ?? groups[0]);
  const current = groups.find((entry) => entry.provider === value.provider);
  const model = current?.models.find((entry) => entry.id === value.model);
  const auto = automatic?.chosen === true;
  const isChecked = (provider: string, entry: Model) => !auto && provider === value.provider && entry.id === value.model;
  // Where it opens: Favorites when the model in use is starred, or with none in use any are; else the agent in use.
  const opensOn = () => ((auto ? favorites.length > 0 : model && isStarred(value.provider, model)) ? FAVORITES : value.provider);
  const opening = () => {
    setBrowsing(opensOn());
    setQuery("");
    setUnderKeys(null);
  };
  if (asked !== seen) {
    setSeen(asked);
    if (!disabled) {
      opening();
      setOpen(true);
    }
  }
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
  // An older model shows under Older models unless it is the one in use or starred; starred ones first.
  const pinned = (provider: string, entry: Model) => !entry.legacy || isChecked(provider, entry) || isStarred(provider, entry);
  const shownOf = (entry: ModelGroup) => {
    const shown = entry.models.filter((each) => pinned(entry.provider, each) || older.has(entry.provider));
    return [...shown.filter((each) => isStarred(entry.provider, each)), ...shown.filter((each) => !isStarred(entry.provider, each))];
  };
  const olderCount = group && !group.unavailable ? group.models.filter((each) => !pinned(group.provider, each)).length : 0;
  // A pick takes the keyboard to its levels once it shows as the one in use.
  useEffect(() => {
    if (!levelsNext.current || !open) return;
    levelsNext.current = false;
    focusChoice(footer.current?.querySelector("[data-picker-part=effort]") ?? null);
  });

  // Another agent's model is a switch (Rust starts a new conversation with a hand-off): asked first.
  const [switching, setSwitching] = useState<ModelChoice | null>(null);
  const pick = (provider: string, next: Model, also?: { effort?: string; fast?: boolean }) => {
    const same = provider === value.provider;
    // A new model keeps the effort within the agent when it has that level, else takes its own default; fast carries
    // over to a model with a fast tier too.
    const kept = same && value.effort && next.efforts.includes(value.effort) ? value.effort : (next.defaultEffort ?? null);
    const fast = Boolean(next.fast) && (also?.fast ?? value.fast === true);
    const choice = { provider, model: next.id, effort: also?.effort ?? kept, ...(fast ? { fast } : {}) };
    setUnderKeys(null);
    if (same || !asksSwitch) {
      onChange(choice);
      if (!also) levelsNext.current = true;
    } else {
      setOpen(false);
      setSwitching(choice);
    }
  };
  // Leaving a row for the footer keeps the model it acts on.
  const keepsInHand = (to: EventTarget | null) => to instanceof Node && Boolean(footer.current?.contains(to));
  const modelRow = (provider: string, entry: Model, mark?: { mark: string | null; label: string }) => {
    const checked = isChecked(provider, entry);
    const star = isStarred(provider, entry);
    return (
      <div key={`${provider}:${entry.id}`} className="group/row relative shrink-0">
        <button
          type="button"
          role="option"
          aria-selected={checked}
          onClick={() => pick(provider, entry)}
          onFocus={() => setUnderKeys({ provider, model: entry })}
          onBlur={(event) => !keepsInHand(event.relatedTarget) && setUnderKeys(null)}
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
        <button
          type="button"
          data-slot="model-picker-star"
          aria-label={star ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`}
          aria-pressed={star}
          onClick={() => void setStar(provider, entry.id, !star).catch(() => undefined)}
          className={cx(
            "absolute end-1.5 top-1.5 grid size-5 cursor-pointer place-items-center rounded-icon-button outline-none hover:bg-fill-hover focus-visible:bg-fill-hover",
            star ? "text-warning" : "text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
          )}
        >
          {star ? <StarFilled aria-hidden className="size-icon-xs" /> : <Star aria-hidden className="size-icon-xs" />}
        </button>
      </div>
    );
  };

  // Favorites or an agent in the sidebar, by its full name, with its count of models shown.
  const sidebarRow = (to: string, label: string, icon: ReactElement, count: number | null, short?: string | null, dim?: boolean) => (
    <button key={to} type="button" role="option" aria-label={label} aria-selected={to === (group?.provider ?? FAVORITES)} onClick={() => setBrowsing(to)} onFocus={() => setBrowsing(to)} className={cx(SIDEBAR_ROW, dim && "opacity-disabled")}>
      {icon}
      <span className="min-w-0 truncate">{short ?? label}</span>
      {count !== null && <span className="ms-auto shrink-0 text-xs text-muted-foreground">{count}</span>}
    </button>
  );

  // The footer's model: the one under the keyboard (the first match while searching), else the one in use.
  const inHand = (inSearch && first ? { provider: first.group.provider, model: first.model } : underKeys) ?? (model && !auto ? { provider: value.provider, model } : null);
  const inHandChecked = Boolean(inHand && isChecked(inHand.provider, inHand.model));
  const levels = auto ? [] : (inHand?.model.efforts ?? []);
  const columnName = auto ? automatic?.label : inHand?.model.name;
  const hasFast = !auto && Boolean(inHand?.model.fast);
  const fastOn = inHandChecked && value.fast === true;
  const chooseLevel = (level: string) => {
    if (!inHand) return;
    if (inHandChecked) onChange({ ...value, effort: level });
    else pick(inHand.provider, inHand.model, { effort: level });
  };
  const chooseSpeed = (fast: boolean) => {
    if (!inHand) return;
    if (inHandChecked) onChange({ ...value, fast });
    else pick(inHand.provider, inHand.model, { fast });
  };
  const fastLabel = value.fast === true && model?.fast;
  const word = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          if (!next && details.reason === "escape-key" && query) {
            details.cancel();
            setQuery("");
            search.current?.focus();
            return;
          }
          if (next) opening();
          setOpen(next);
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            trigger ?? (
              <ComposerPill
                aria-label={`Model: ${auto ? automatic?.label : `${model?.name ?? value.model}${fastLabel ? ", Fast" : ""}${word ? `, ${word}` : ""}`}`}
                data-slot="model-picker-trigger"
              />
            )
          }
        >
          {/* The old pill's tighter gap; the pill's own is set in its base. */}
          <span className="flex min-w-0 items-center gap-1">
            {auto ? (
              <span className="truncate text-foreground">{automatic?.label}</span>
            ) : (
              <>
                <ProviderMark mark={current?.mark ?? null} className="size-icon-sm" />
                {fastLabel && <Bolt aria-hidden className="text-foreground" />}
                <span className="truncate text-foreground">{model?.name ?? value.model}</span>
                {word && <span className="shrink-0">{word}</span>}
              </>
            )}
            <ChevronDown className="size-icon-xs" />
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          padded={false}
          aria-label="Model"
          initialFocus={search}
          className="max-w-full overflow-hidden"
        >
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the search's, the lists' and the footer's keys */}
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
                onBlur={(event) => !keepsInHand(event.relatedTarget) && setInSearch(false)}
                placeholder="Search every agent"
                aria-label="Search every agent"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
            {automatic && (
              <div data-slot="model-picker-band" className="flex shrink-0 items-start gap-2.5 border-b border-divider px-4 py-3">
                <Sparkles aria-hidden className="mt-0.5 size-icon-md shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{automatic.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{automatic.hint}</div>
                </div>
                <Switch data-slot="model-picker-automatic" aria-label="Automatic" checked={auto} onCheckedChange={(on) => (on ? automatic.onChoose() : automatic.onTurnOff())} className="mt-0.5" />
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              {!matches && (
                <>
                  <div role="listbox" aria-label="Agents" data-picker-part="agents" className={cx("flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5", auto && "opacity-disabled")}>
                    {sidebarRow(FAVORITES, "Favorites", <StarFilled aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />, favorites.length)}
                    <div role="presentation" className="h-1.5 shrink-0" />
                    {groups.map((entry) =>
                      sidebarRow(entry.provider, entry.label, <ProviderMark mark={entry.mark} className="size-icon-md" />, entry.unavailable ? null : entry.models.filter((each) => pinned(entry.provider, each)).length, entry.short, Boolean(entry.unavailable)),
                    )}
                  </div>
                  <div aria-hidden className="w-px shrink-0 bg-divider" />
                </>
              )}
              <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-1.5", auto && "opacity-disabled")}>
                <div
                  role="listbox"
                  aria-label={matches ? "Matching models" : group ? `${group.label} models` : "Favorites"}
                  data-picker-part="models"
                  className="flex flex-col gap-0.5"
                >
                  {matches
                    ? matches.map((row) => modelRow(row.group.provider, row.model, row.group))
                    : group
                      ? !group.unavailable && shownOf(group).map((entry) => modelRow(group.provider, entry))
                      : favorites.map((row) => modelRow(row.group.provider, row.model, row.group))}
                  {!matches && olderCount > 0 && (
                    <button
                      type="button"
                      data-picker-older=""
                      aria-expanded={older.has(group!.provider)}
                      onClick={() =>
                        setOlder((now) => {
                          const next = new Set(now);
                          if (!next.delete(group!.provider)) next.add(group!.provider);
                          return next;
                        })
                      }
                      className="group flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-surface px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:bg-fill"
                    >
                      <ChevronRight aria-hidden className="size-icon-sm transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
                      Older models · {olderCount}
                    </button>
                  )}
                </div>
                {matches?.length === 0 && <p className="px-2.5 py-1.75 text-xs text-muted-foreground">No models match “{needle}”</p>}
                {!matches && !group && favorites.length === 0 && <p className="px-2.5 py-1.75 text-xs text-muted-foreground">No favorites yet</p>}
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
            {efforts && (
              <div ref={footer} className={cx("shrink-0 border-t border-divider", auto && "opacity-disabled")}>
                <div className={cx(FOOTER_ROW, "h-11")}>
                  <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    Effort
                    {columnName && <span className="opacity-75"> · {columnName}</span>}
                  </div>
                  {levels.length === 0 ? (
                    <div className="shrink-0 pe-1.75 text-xs text-muted-foreground">{auto || inHand ? "No effort levels" : "Pick a model"}</div>
                  ) : (
                    <SegmentedRoot
                      aria-label="Effort"
                      data-picker-part="effort"
                      value={inHandChecked && value.effort ? [value.effort] : []}
                      onValueChange={([level]) => level && chooseLevel(level)}
                      className="flex shrink-0 items-center gap-0.5"
                    >
                      {levels.map((level) => (
                        <Segment key={level} value={level} title={level === inHand?.model.defaultEffort ? "Default" : undefined} className={SEGMENT}>
                          {effortLabel(level)}
                        </Segment>
                      ))}
                    </SegmentedRoot>
                  )}
                </div>
                {hasFast && (
                  <div className={cx(FOOTER_ROW, "h-10 pb-2")}>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Speed</span>
                    <SegmentedRoot
                      aria-label="Speed"
                      data-picker-part="speed"
                      value={[fastOn ? "fast" : "standard"]}
                      onValueChange={([speed]) => speed && chooseSpeed(speed === "fast")}
                      className="flex shrink-0 items-center gap-0.5"
                    >
                      <Segment value="standard" className={SEGMENT}>
                        Standard
                      </Segment>
                      <Segment value="fast" title={inHand?.model.fast ?? undefined} className={SEGMENT}>
                        <Bolt aria-hidden className="size-icon-xs" />
                        Fast
                      </Segment>
                    </SegmentedRoot>
                  </div>
                )}
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
