// Mockup only: the model picker as a menu of three columns (agents · search and models · effort), opened from the composer's
// model pill, no strip. Fake agents, models and limits over the real composer parts; live: search, stars, effort, Fast,
// Switch's confirm, the keys. ?v=a|b|c is the variant. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { countdown, tightest } from "../src/accounts/usage";
import type { Limit } from "../src/accounts/api";
import { COLUMN, ComposerPill, ContextRing, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { fuzzyMatch, MatchedText } from "../src/components/composer/menus";
import { effortLabel, type Model, type ModelChoice, type ModelGroup, ModelLabel, modelWords, ProviderMark } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { type Quota, QuotaLines } from "../src/components/composer/quota-lines";
import { SendButton } from "../src/components/composer/send-button";
import { SwitchAgentDialog } from "../src/components/composer/switch-agent";
import { cx } from "../src/components/cx";
import { itemBase } from "../src/components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover";
import { RowAction } from "../src/components/row-action";
import { Segmented } from "../src/components/segmented";
import { Switch } from "../src/components/switch";
import { UserBubble } from "../src/components/thread/message";
import { showToast, Toaster } from "../src/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { UsageBar } from "../src/components/usage-bar";
import { Bolt, Check, ChevronDown, MagnifyingGlassSmSearch, Star, StarFilled } from "../src/icons";
import { matches } from "../src/shortcuts";
import { groups, NOW, type Ready } from "./model-picker-fake";

type Row = { group: ModelGroup; model: Model };
const keyOf = ({ group, model }: Row) => `${group.provider}/${model.id}`;
const FAVORITES = "favorites";

/** What an account has left, by its tightest limit; null where nothing is known. */
function left({ limits }: Quota) {
  const top = tightest(limits.filter((limit): limit is Limit => limit.used !== null));
  return top && { name: top.name, percent: 100 - top.used, resets: top.resets };
}

type Props = { groups: ModelGroup[]; value: ModelChoice; onChange: (value: ModelChoice) => void; stars: ReadonlySet<string>; onStar: (key: string) => void; onSetUp: (group: ModelGroup) => void };

/** The picker's state, one for the three variants: the agent browsed, the search, the row under the keyboard, picks. */
function usePicker({ groups, value, onChange, stars }: Props) {
  const [tab, setTab] = useState(value.provider);
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [switching, setSwitching] = useState<ModelChoice | null>(null);
  const [cursor, setCursor] = useState<string | null>(`${value.provider}/${value.model}`);
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const group = groups.find((each) => each.provider === tab) ?? null;
  const all: Row[] = groups.flatMap((each) => each.models.map((model) => ({ group: each, model })));
  const needle = query.trim();
  const rows = needle
    ? all.map((row) => ({ row, rank: fuzzyMatch(row.model.name, needle)?.rank })).filter((each) => each.rank !== undefined).toSorted((a, b) => a.rank! - b.rank!).map((each) => each.row)
    : tab === FAVORITES
      ? all.filter((row) => stars.has(keyOf(row)))
      : all.filter((row) => row.group.provider === tab).toSorted((a, b) => Number(a.model.legacy ?? false) - Number(b.model.legacy ?? false));
  const isOld = (row: Row) => !needle && tab !== FAVORITES && row.model.legacy === true && keyOf(row) !== `${value.provider}/${value.model}` && !stars.has(keyOf(row));
  const hidden = rows.filter(isOld).length;
  const shown = older ? rows : rows.filter((row) => !isOld(row));
  const at = Math.max(0, shown.findIndex((row) => keyOf(row) === cursor));
  const used = all.find((row) => keyOf(row) === `${value.provider}/${value.model}`)!;

  const pick = ({ group, model }: Row) => {
    const same = group.provider === value.provider;
    const effort = same && value.effort && model.efforts.includes(value.effort) ? value.effort : (model.defaultEffort ?? null);
    const choice = { provider: group.provider, model: model.id, effort, ...(model.fast && value.fast ? { fast: true } : {}) };
    setCursor(keyOf({ group, model }));
    if (same) onChange(choice);
    else setSwitching(choice);
  };
  const browse = (next: string) => {
    setTab(next);
    setQuery("");
    setCursor(`${value.provider}/${value.model}`);
  };
  const focusOn = (part: string) => {
    const box = root.current?.querySelector(`[data-part=${part}]`);
    (box?.querySelector<HTMLElement>("[tabindex='0'], [aria-checked=true], [aria-pressed=true]") ?? box?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
  };
  useEffect(() => {
    root.current?.querySelector("[data-part=models] [data-highlighted]")?.scrollIntoView({ block: "nearest" });
  }, [cursor, tab, needle]);
  /** In the search: ↑ ↓ the models, Enter picks, ← the agents, → the effort levels. */
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step) setCursor(shown[Math.min(shown.length - 1, Math.max(0, at + step))] ? keyOf(shown[Math.min(shown.length - 1, Math.max(0, at + step))]!) : null);
    else if (event.key === "Enter" && shown[at]) pick(shown[at]);
    else if (event.key === "ArrowLeft" && !query) focusOn("agents");
    else if (event.key === "ArrowRight" && event.currentTarget.selectionStart === query.length) focusOn("effort");
    else if (event.key === "Escape" && query) {
      event.stopPropagation();
      setQuery("");
    } else return;
    event.preventDefault();
  };
  /** In the agents and the effort levels: ↑ ↓ move and choose, sideways goes back to the search. */
  const columnKeys = (out: "ArrowLeft" | "ArrowRight") => (event: KeyboardEvent<HTMLElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-item]:not(:disabled)")];
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === out) field.current?.focus();
    else if (step) {
      const next = items[Math.min(items.length - 1, Math.max(0, items.indexOf(event.target as HTMLElement) + step))];
      next?.focus();
      next?.click();
    } else return;
    event.preventDefault();
  };
  return { tab, browse, group, query, setQuery, needle, shown, hidden, older, setOlder, at, setCursor, used, pick, field, root, searchKeys, columnKeys, switching, setSwitching };
}
type Picker = ReturnType<typeof usePicker>;

const Tip = ({ tip, side = "left", children }: { tip: ReactNode; side?: "left" | "top" | "right"; children: ReactElement }) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent side={side}>{tip}</TooltipContent>
  </Tooltip>
);

/** The search over every agent's models. */
function Search({ picker, className }: { picker: Picker; className?: string }) {
  return (
    <label className={cx("flex shrink-0 cursor-text items-center gap-2 text-label", className)}>
      <MagnifyingGlassSmSearch aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
      <input
        ref={picker.field}
        value={picker.query}
        onChange={(event) => (picker.setQuery(event.target.value), picker.setCursor(null))}
        onKeyDown={picker.searchKeys}
        placeholder="Search models"
        aria-label="Search models"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-placeholder"
      />
    </label>
  );
}

const STAR_ON = "text-glyph-5";

/** The models of the agent browsed, the starred ones, or the search's matches. `marks`: each row under its agent's mark. */
function Models({ picker, marks, ...props }: Props & { picker: Picker; marks: "always" | "mixed" }) {
  const { group, shown, needle, tab } = picker;
  const mixed = Boolean(needle) || tab === FAVORITES;
  const note = "px-2 py-1.5 text-label text-muted-foreground";
  return (
    <div data-part="models" role="listbox" aria-label="Models" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
      {shown.map((row, index) => {
        const key = keyOf(row);
        const used = row === picker.used || key === `${props.value.provider}/${props.value.model}`;
        const starred = props.stars.has(key);
        return (
          <div key={key} role="option" aria-selected={used} data-highlighted={index === picker.at || undefined} onMouseMove={() => picker.setCursor(key)} className={cx(itemBase, "group/row pe-1 shrink-0")} onClick={() => picker.pick(row)}>
            {(marks === "always" || mixed) && <ProviderMark mark={row.group.mark} className="size-icon-md" />}
            <span className="min-w-0 truncate">{needle ? <MatchedText text={row.model.name} query={needle} hit="font-semibold text-foreground" /> : row.model.name}</span>
            {used && <Check aria-label="In use" className="size-icon-sm text-foreground" />}
            {row.model.legacy && mixed && <span className="text-xs text-placeholder">Older</span>}
            <RowAction
              aria-label={starred ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={starred}
              className={cx("ms-auto", !starred && "opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100")}
              onClick={(event) => (event.stopPropagation(), props.onStar(key))}
            >
              {starred ? <StarFilled className={STAR_ON} /> : <Star />}
            </RowAction>
          </div>
        );
      })}
      {picker.hidden > 0 && (
        <button type="button" onClick={() => picker.setOlder(!picker.older)} className={cx(itemBase, "shrink-0 pe-2 text-start text-muted-foreground hover:bg-fill focus-visible:focus-ring")}>
          <ChevronDown aria-hidden className={cx(picker.older && "rotate-180")} />
          {picker.older ? "Fewer models" : `${picker.hidden} older`}
        </button>
      )}
      {!needle && group?.unavailable && <NotSetUp group={group} onSetUp={props.onSetUp} />}
      {needle && shown.length === 0 && <p className={note}>No models match “{needle}”</p>}
      {!needle && tab === FAVORITES && shown.length === 0 && <p className={note}>Star a model and it shows here.</p>}
    </div>
  );
}

const SETUP_BUTTON = "flex h-control-sm shrink-0 cursor-pointer items-center rounded-capsule bg-control px-3 text-label font-medium text-foreground hover:bg-selection focus-visible:focus-ring";

function NotSetUp({ group, onSetUp }: { group: ModelGroup; onSetUp: Props["onSetUp"] }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-label text-muted-foreground">
      <ProviderMark mark={group.mark} className="size-icon-mark opacity-picker-dim" />
      <p>{group.unavailable === "install" ? `${group.label} isn't installed. Install it and its models show here.` : `${group.label} isn't signed in. Sign in and its models show here.`}</p>
      <button type="button" className={SETUP_BUTTON} onClick={() => onSetUp(group)}>
        Set up
      </button>
    </div>
  );
}

/** The levels as rows, a check on the one in use and the model's own default named. */
function EffortRows({ picker, value, onChange }: Props & { picker: Picker }) {
  const { model } = picker.used;
  if (model.efforts.length === 0) return <p className="px-2 py-1.5 text-label text-muted-foreground">No effort levels</p>;
  return (
    <div data-part="effort" role="radiogroup" aria-label="Effort" onKeyDown={picker.columnKeys("ArrowLeft")} className="flex flex-col gap-px">
      {model.efforts.map((level) => {
        const on = value.effort === level;
        return (
          <button key={level} type="button" role="radio" data-item="" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange({ ...value, effort: level })} className={cx(itemBase, "w-full pe-2 text-start hover:bg-fill focus-visible:bg-fill")}>
            <span className="flex-1 truncate">{effortLabel(level)}</span>
            {on ? <Check aria-hidden className="size-icon-sm text-foreground" /> : level === model.defaultEffort && <span className="text-xs text-placeholder">Default</span>}
          </button>
        );
      })}
    </div>
  );
}

const RAIL_BUTTON = "relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-icon-button text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:focus-ring aria-pressed:text-foreground aria-pressed:bg-selection";

/** The agents as marks, Favorites over them; `bar`: a short line by the one browsed. */
function Rail({ picker, groups, bar }: Props & { picker: Picker; bar?: boolean }) {
  const line = (on: boolean) => on && bar && <span aria-hidden className="absolute -end-1 h-5 w-0.75 rounded-full bg-foreground" />;
  const on = (id: string) => !picker.needle && picker.tab === id;
  return (
    <div data-part="agents" role="toolbar" aria-label="Agents" aria-orientation="vertical" onKeyDown={picker.columnKeys("ArrowRight")} className="flex shrink-0 flex-col gap-1 overflow-y-auto p-1 hide-scrollbar">
      <Tip tip="Favorites">
        <button type="button" data-item="" aria-label="Favorites" aria-pressed={on(FAVORITES)} tabIndex={on(FAVORITES) ? 0 : -1} onClick={() => picker.browse(FAVORITES)} className={RAIL_BUTTON}>
          <StarFilled aria-hidden className="size-icon-lg" />
          {line(on(FAVORITES))}
        </button>
      </Tip>
      <span aria-hidden className="mx-1 h-px shrink-0 bg-divider" />
      {groups.map((group) => (
        <Tip key={group.provider} tip={group.unavailable ? `${group.label}: ${group.unavailable === "install" ? "not installed" : "not signed in"}` : group.label}>
          <button type="button" data-item="" aria-label={group.label} aria-pressed={on(group.provider)} tabIndex={on(group.provider) ? 0 : -1} onClick={() => picker.browse(group.provider)} className={RAIL_BUTTON}>
            <ProviderMark mark={group.mark} className={cx("size-icon-lg", group.unavailable && "opacity-picker-dim")} />
            {line(on(group.provider))}
          </button>
        </Tip>
      ))}
    </div>
  );
}

/** A: the compact layout. One rule across the top, levels as rows, and a footer with the speed and what's left. */
function VariantA(props: Props) {
  const picker = usePicker(props);
  const { model, group } = picker.used;
  const browsed = picker.group ?? group;
  return (
    <Frame picker={picker} {...props} className="w-132">
      <div className="flex h-66 min-h-0">
        <Rail picker={picker} {...props} bar />
        <div className="flex min-w-0 flex-1 flex-col border-s border-divider">
          <Search picker={picker} className="mx-3 h-10 border-b border-divider" />
          <Models picker={picker} marks="always" {...props} />
        </div>
        <div className="flex w-44 shrink-0 flex-col border-s border-divider">
          <div className="mx-3 flex h-10 shrink-0 items-center gap-2 border-b border-divider text-label">
            <span className="text-muted-foreground">Effort</span>
            <span className="ms-auto truncate text-xs text-placeholder">{model.name}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            <EffortRows picker={picker} {...props} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-divider bg-fill-faint px-3 py-2">
        <div className="min-w-0 flex-1">{browsed.usage ? <QuotaLines usage={browsed.usage} /> : <p className="text-xs text-muted-foreground">{browsed.label} reports no limits</p>}</div>
        <Segmented
          label="Speed"
          value={props.value.fast && model.fast ? "fast" : "standard"}
          options={[
            { value: "standard", label: "Standard" },
            { value: "fast", label: <span className="flex items-center gap-1"><Bolt aria-hidden className={cx("size-icon-xs", props.value.fast && model.fast && "text-glyph-5")} />Fast</span>, tip: model.fast ?? undefined, reason: model.fast ? null : `${model.name} has no fast tier` },
          ]}
          onChange={(speed) => props.onChange({ ...props.value, fast: speed === "fast" })}
          className="rounded-capsule bg-fill-subtle p-0.5"
        />
      </div>
    </Frame>
  );
}

/** B: the third column holds all about the model in use: its levels as today's scale, Fast as a switch, then what's left. No footer. */
function VariantB(props: Props) {
  const picker = usePicker(props);
  const { model, group } = picker.used;
  const { value, onChange } = props;
  return (
    <Frame picker={picker} {...props} className="w-140">
      <div className="flex h-84 min-h-0">
        <Rail picker={picker} {...props} />
        <div className="flex min-w-0 flex-1 flex-col pt-1 pe-1">
          <Search picker={picker} className="mx-1 h-control-md rounded-capsule bg-fill-faint px-2.5 focus-within:bg-fill-subtle" />
          <Models picker={picker} marks="mixed" {...props} />
        </div>
        <div className="m-1 flex w-52 shrink-0 flex-col rounded-control bg-fill-faint p-3">
          <div className="flex min-w-0 items-center gap-1.5 text-label font-medium">
            <ProviderMark mark={group.mark} className="size-icon-md" />
            <span className="truncate">{model.name}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-2 scroll-edge-fade edge-fade-group">
            <EffortScale picker={picker} {...props} />
          </div>
          <label title={model.fast ?? `${model.name} has no fast tier`} className={cx("flex items-center gap-1.5 border-t border-divider py-2.5 text-label", model.fast ? "cursor-pointer" : "text-placeholder")}>
            <Bolt aria-hidden className={cx("size-icon-sm", value.fast && model.fast ? "text-glyph-5" : "text-placeholder")} />
            <span className="flex-1">Fast</span>
            <Switch aria-label="Fast" checked={Boolean(value.fast && model.fast)} disabled={!model.fast} onCheckedChange={(fast) => onChange({ ...value, fast })} />
          </label>
          <div className="flex flex-col gap-2 border-t border-divider pt-2.5">
            {group.usage ? group.usage.map((account) => <Left key={account.account} account={account} />) : <p className="text-xs text-muted-foreground">{group.label} reports no limits</p>}
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** One account's tightest limit, as a bar of what's left. */
function Left({ account }: { account: Quota }) {
  const now = left(account);
  if (!now) return <p className="text-xs text-muted-foreground">{account.name} · Not reported yet</p>;
  return (
    <div className="flex flex-col gap-1 text-xs tabular-nums" title={now.resets === null ? now.name : `${now.name}, resets in ${countdown(now.resets, NOW)}`}>
      <span className="flex justify-between gap-2">
        <span className="truncate text-muted-foreground">{account.name} · {now.name}</span>
        <span className="shrink-0">{now.percent}% left</span>
      </span>
      <UsageBar value={now.percent} fill={now.percent < 20 ? "bg-warning" : "bg-foreground"} label={`${account.name} ${now.name} left`} />
      {now.resets !== null && <span className="text-placeholder">Resets in {countdown(now.resets, NOW)}</span>}
    </div>
  );
}

/** Today's scale, highest on top, as the strip draws it. */
function EffortScale({ picker, value, onChange }: Props & { picker: Picker }) {
  const { model } = picker.used;
  if (model.efforts.length === 0) return <p className="text-label text-muted-foreground">No effort levels</p>;
  return (
    <div data-part="effort" role="radiogroup" aria-label="Effort" onKeyDown={picker.columnKeys("ArrowLeft")} className="relative flex flex-col">
      <span aria-hidden className="absolute inset-y-2.5 start-1.25 w-0.5 bg-control" />
      {model.efforts.toReversed().map((level) => {
        const on = value.effort === level;
        return (
          <button key={level} type="button" role="radio" data-item="" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange({ ...value, effort: level })} className="group/step relative flex h-control-xs cursor-pointer items-center gap-2 rounded-sm text-start text-label text-muted-foreground hover:text-foreground focus-visible:focus-ring aria-checked:font-medium aria-checked:text-foreground">
            <span className="grid w-3 shrink-0 place-items-center">
              <span className="size-1 rounded-full bg-placeholder group-aria-checked/step:size-2.5 group-aria-checked/step:bg-foreground" />
            </span>
            <span className="flex-1">{effortLabel(level)}</span>
            {level === model.defaultEffort && <span className="text-xs font-normal text-placeholder">Default</span>}
          </button>
        );
      })}
    </div>
  );
}

/** C: the agents by name, each with what it has left or its Set up; the effort column carries the Fast key. */
function VariantC(props: Props) {
  const picker = usePicker(props);
  const { model } = picker.used;
  const { groups, value, onChange } = props;
  const fast = Boolean(value.fast && model.fast);
  const on = (id: string) => !picker.needle && picker.tab === id;
  const row = "flex min-h-control-lg w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-menu-item px-2 py-1 text-start text-label hover:bg-fill focus-visible:focus-ring aria-pressed:bg-selection";
  const under = "truncate text-xs text-muted-foreground tabular-nums";
  return (
    <Frame picker={picker} {...props} className="w-152">
      <div className="flex h-70 min-h-0">
        <div data-part="agents" role="toolbar" aria-label="Agents" aria-orientation="vertical" onKeyDown={picker.columnKeys("ArrowRight")} className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
          <button type="button" data-item="" aria-pressed={on(FAVORITES)} tabIndex={on(FAVORITES) ? 0 : -1} onClick={() => picker.browse(FAVORITES)} className={row}>
            <StarFilled aria-hidden className="size-icon-lg shrink-0 text-muted-foreground" />
            <span className="flex-1">Favorites</span>
            <span className="text-xs text-placeholder tabular-nums">{props.stars.size}</span>
          </button>
          <span aria-hidden className="mx-2 my-0.5 h-px shrink-0 bg-divider" />
          {groups.map((group) => {
            const accounts = (group.usage ?? []).flatMap((account) => { const now = left(account); return now ? [{ ...now, name: account.name }] : []; });
            const button = (
              <button key={group.provider} type="button" data-item="" aria-pressed={on(group.provider)} tabIndex={on(group.provider) ? 0 : -1} onClick={() => picker.browse(group.provider)} className={row}>
                <ProviderMark mark={group.mark} className={cx("size-icon-lg", group.unavailable && "opacity-picker-dim")} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cx("truncate", group.unavailable && "text-muted-foreground")}>{group.label}</span>
                  {group.unavailable ? <span className={under}>{group.unavailable === "install" ? "Not installed" : "Not signed in"}</span> : accounts.map((each) => <span key={each.name} className={under}>{each.name} {each.percent}% left</span>)}
                </span>
              </button>
            );
            return group.usage ? <Tip key={group.provider} tip={<QuotaLines usage={group.usage} />}>{button}</Tip> : button;
          })}
        </div>
        <div className="flex min-w-0 flex-1 flex-col border-s border-divider">
          <Search picker={picker} className="h-10 border-b border-divider px-3" />
          <Models picker={picker} marks="mixed" {...props} />
        </div>
        <div className="flex w-38 shrink-0 flex-col border-s border-divider">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-divider px-3 text-label"><span className="text-muted-foreground">Effort</span><span className="ms-auto truncate text-xs text-placeholder">{model.name}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            <EffortRows picker={picker} {...props} />
          </div>
          <div className="border-t border-divider p-1">
            <button type="button" role="switch" aria-checked={fast} disabled={!model.fast} title={model.fast ?? `${model.name} has no fast tier`} onClick={() => onChange({ ...value, fast: !fast })} className={cx(itemBase, "w-full pe-2 text-start hover:bg-fill focus-visible:focus-ring disabled:cursor-default disabled:opacity-picker-dim")}>
              <Bolt aria-hidden className={cx(fast && "text-glyph-5")} />
              <span className="flex-1">Fast</span>
              <span className={cx("text-xs", fast ? "text-foreground" : "text-placeholder")}>{fast ? "On" : "Off"}</span>
            </button>
          </div>
        </div>
      </div>
    </Frame>
  );
}

function Frame({ picker, groups, onChange, className, children }: Props & { picker: Picker; className: string; children: ReactNode }) {
  return (
    <div ref={picker.root} data-slot="model-picker" className={cx("flex max-w-available flex-col overflow-hidden rounded-surface", className)}>
      {children}
      <SwitchAgentDialog
        to={picker.switching && (groups.find((each) => each.provider === picker.switching?.provider)?.label ?? null)}
        onCancel={() => picker.setSwitching(null)}
        onConfirm={() => {
          if (picker.switching) onChange(picker.switching);
          picker.setSwitching(null);
        }}
      />
    </div>
  );
}

const VARIANTS: Record<string, (props: Props) => ReactNode> = { a: VariantA, b: VariantB, c: VariantC };
const Variant = VARIANTS[new URLSearchParams(location.search).get("v") ?? "a"] ?? VariantA;

function Page() {
  const [ready, setReady] = useState<Ready>("ready");
  const list = groups(ready);
  const [value, setValue] = useState<ModelChoice>({ provider: "claude", model: "opus", effort: "high", fast: true });
  const [stars, setStars] = useState<ReadonlySet<string>>(new Set(["claude/opus", "claude/sonnet", "codex/sol"]));
  const [open, setOpen] = useState(true);
  const [level, setLevel] = useState<PermissionLevel>("auto");
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      if (!matches(event, "model")) return;
      event.preventDefault();
      setOpen((now) => !now);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  return (
    <main className="flex h-screen min-h-160 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-4 py-2 text-xs text-muted-foreground">
        Mockup: OpenCode is
        <Segmented label="OpenCode" value={ready} onChange={setReady} options={[{ value: "ready", label: "Ready" }, { value: "sign-in", label: "Not signed in" }, { value: "install", label: "Not installed" }]} />
      </div>
      <div className="min-h-0 w-full flex-1 overflow-hidden px-scrollbar">
        <div className={cx(COLUMN, "flex flex-col gap-4 py-6 text-chat")}>
          <UserBubble keep="u1" text="Why does the tab test fail now and then?" />
          <p>It reads the strip before the closing tab has gone. It now waits for that.</p>
        </div>
      </div>
      <SharedComposer
        plus={<PlusButton />}
        level={<PermissionPicker value={level} onChange={setLevel} />}
        ring={<ContextRing usedTokens={45_000} windowTokens={258_000} />}
        model={
          <Popover open={open} onOpenChange={(next, details) => (details.reason === "focus-out" ? undefined : setOpen(next))}>
            <PopoverTrigger render={<ComposerPill aria-label={modelWords(list, value)} />}>
              <ModelLabel groups={list} value={value} mark="size-icon-sm" />
            </PopoverTrigger>
            <PopoverContent side="top" align="end" padded={false} aria-label="Model" initialFocus={() => document.querySelector<HTMLElement>("[data-slot=model-picker] input")} collisionAvoidance={{ side: "none" }}>
              <Variant
                groups={list}
                value={value}
                onChange={setValue}
                stars={stars}
                onStar={(key) => setStars((now) => (now.has(key) ? new Set([...now].filter((each) => each !== key)) : new Set([...now, key])))}
                onSetUp={(group) => (setOpen(false), showToast(`Set up ${group.label} opens here`))}
              />
            </PopoverContent>
          </Popover>
        }
        send={<SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}
      >
        <div className="min-h-composer px-2 py-2.5 text-base text-placeholder">Do anything</div>
      </SharedComposer>
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
