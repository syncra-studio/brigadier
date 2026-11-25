// Mockup only: the model picker as a menu of three columns (agents · search and models · effort, with Fast and what's left), opened from the composer's
// model pill, no strip, and from a new chat, Settings, Fork and a side chat. Fake agents, models and limits over the real
// composer parts; live: search, stars, effort, Fast, Switch's confirm, the keys. ?v=a|b is the variant. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { countdown, tightest } from "../src/accounts/usage";
import type { Limit } from "../src/accounts/api";
import { COLUMN, ComposerPill, ContextRing, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { fuzzyMatch, MatchedText } from "../src/components/composer/menus";
import { effortLabel, type Model, type ModelChoice, type ModelGroup, ModelLabel, modelWords, ProviderMark } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { useClosesOnTyping } from "../src/components/composer/model-keys";
import type { Quota } from "../src/components/composer/quota-lines";
import { SendButton } from "../src/components/composer/send-button";
import { SwitchAgentDialog } from "../src/components/composer/switch-agent";
import { cx } from "../src/components/cx";
import { itemBase } from "../src/components/menu";
import { Kbd } from "../src/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover";
import { RowAction } from "../src/components/row-action";
import { Segmented } from "../src/components/segmented";
import { SelectTrigger } from "../src/components/select";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { Switch } from "../src/components/switch";
import { UserBubble } from "../src/components/thread/message";
import { showToast, Toaster } from "../src/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { UsageBar } from "../src/components/usage-bar";
import { Bolt, BranchAlt, Check, ChevronDown, MagnifyingGlassSmSearch, Star, StarFilled } from "../src/icons";
import { keysOf, matches } from "../src/shortcuts";
import { groups, NOW, type Ready } from "./model-picker-fake";

type Row = { group: ModelGroup; model: Model };
const keyOf = ({ group, model }: Row) => `${group.provider}/${model.id}`;
const FAVORITES = "favorites";

/** What an account has left, by its tightest limit; null where nothing is known. */
function left({ limits }: Quota) {
  const top = tightest(limits.filter((limit): limit is Limit => limit.used !== null));
  return top && { name: top.name, percent: 100 - top.used, resets: top.resets };
}

type Props = { groups: ModelGroup[]; value: ModelChoice; onChange: (value: ModelChoice) => void; stars: ReadonlySet<string>; onStar: (key: string) => void; onSetUp: (group: ModelGroup) => void; close: () => void; efforts: boolean; asksSwitch: boolean };

/** The picker's state, one for both variants: the agent browsed, the search, the row under the keyboard, picks. */
function usePicker({ groups, value, onChange, stars, close, asksSwitch }: Props) {
  const [tab, setTab] = useState(stars.size > 0 ? FAVORITES : value.provider);
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
  const found = shown.findIndex((row) => keyOf(row) === cursor);
  const at = found < 0 && needle ? 0 : found;
  const used = all.find((row) => keyOf(row) === `${value.provider}/${value.model}`)!;

  /** The row the third column is about: the highlighted one, else the model in use. */
  const inHand = shown[at] ?? used;
  const inUse = (row: Row) => keyOf(row) === keyOf(used);

  /** Picks a model, with a level or Fast where one was clicked, and closes; Fast (`stay`) keeps it open. */
  const pick = ({ group, model }: Row, also: { effort?: string; fast?: boolean } = {}, stay = false) => {
    const same = group.provider === value.provider;
    const effort = also.effort ?? (same && value.effort && model.efforts.includes(value.effort) ? value.effort : (model.defaultEffort ?? null));
    const choice = { provider: group.provider, model: model.id, effort, ...(model.fast && (also.fast ?? value.fast) ? { fast: true } : {}) };
    setCursor(keyOf({ group, model }));
    if (!same && asksSwitch) return setSwitching(choice);
    onChange(choice);
    if (!stay) close();
  };
  // ⌘1–9 pick the first nine while it's open, ahead of the tabs' own keys.
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      const row = matches(event, "show-tab") && !switching && shown[Number(/[1-9]$/.exec(event.code)?.[0]) - 1];
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      pick(row);
    };
    window.addEventListener("keydown", press, true);
    return () => window.removeEventListener("keydown", press, true);
  });
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
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + step))];
    if (step) setCursor(next ? keyOf(next) : null);
    else if (event.key === "Enter" && shown[at]) pick(shown[at]);
    else if (event.key === "ArrowLeft" && !query) focusOn("agents");
    else if (event.key === "ArrowRight" && event.currentTarget.selectionStart === query.length) focusOn("effort");
    else if (event.key === "Escape" && query) {
      event.stopPropagation();
      setQuery("");
    } else return;
    event.preventDefault();
  };
  /** In the agents ↑ ↓ move and choose; in the effort levels they only move, as a pick closes. Sideways goes back to the search. */
  const columnKeys = (out: "ArrowLeft" | "ArrowRight") => (event: KeyboardEvent<HTMLElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-item]:not(:disabled)")];
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (event.key === out) field.current?.focus();
    else if (step) {
      const next = items[Math.min(items.length - 1, Math.max(0, items.indexOf(event.target as HTMLElement) + step))];
      next?.focus();
      if (out === "ArrowRight") next?.click();
    } else return;
    event.preventDefault();
  };
  return { tab, browse, group, query, setQuery, needle, shown, hidden, older, setOlder, at, setCursor, used, inHand, inUse, pick, field, root, searchKeys, columnKeys, switching, setSwitching };
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
        placeholder="Search all models"
        aria-label="Search all models"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-placeholder"
      />
    </label>
  );
}

const JUMP = keysOf("show-tab")[0]!;
const STAR_ON = "text-glyph-5";

/** The models of the agent browsed, the starred ones, or the search's matches. */
function Models({ picker, ...props }: Props & { picker: Picker }) {
  const { group, shown, needle, tab } = picker;
  const mixed = Boolean(needle) || tab === FAVORITES;
  const note = "px-2 py-1.5 text-label text-muted-foreground";
  return (
    <div data-part="models" role="listbox" aria-label="Models" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
      {shown.map((row, index) => {
        const key = keyOf(row);
        const used = picker.inUse(row);
        const starred = props.stars.has(key);
        return (
          <div key={key} role="option" aria-selected={used} data-highlighted={index === picker.at || undefined} // Sideways moves keep the row: the pointer is on its way to the effort levels.
            onMouseMove={(event) => Math.abs(event.movementX) <= Math.abs(event.movementY) && picker.setCursor(key)} className={cx(itemBase, "group/row shrink-0 pe-2 hover:bg-fill")} onClick={() => picker.pick(row)}>
            <ProviderMark mark={row.group.mark} className="size-icon-md" />
            <span className="min-w-0 py-1 wrap-break-word">{needle ? <MatchedText text={row.model.name} query={needle} hit="font-semibold text-foreground" /> : row.model.name}</span>
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
            {index < 9 && <Kbd className="shrink-0">{JUMP.replace("1–9", `${index + 1}`)}</Kbd>}
          </div>
        );
      })}
      {picker.hidden > 0 && (
        <button type="button" onClick={() => picker.setOlder(!picker.older)} className={cx(itemBase, "shrink-0 pe-2 text-start text-muted-foreground hover:bg-fill focus-visible:focus-ring")}>
          <ChevronDown aria-hidden className={cx(picker.older && "rotate-180")} />
          {picker.older ? "Show less" : `Show ${picker.hidden} more`}
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
function EffortRows({ picker, value }: Props & { picker: Picker }) {
  const { model } = picker.inHand;
  const used = picker.inUse(picker.inHand);
  if (model.efforts.length === 0) return <p className="px-2 py-1.5 text-label text-muted-foreground">No effort levels</p>;
  return (
    <div data-part="effort" role="radiogroup" aria-label="Effort" onKeyDown={picker.columnKeys("ArrowLeft")} className="flex flex-col gap-px">
      {model.efforts.map((level, index) => {
        const on = used && value.effort === level;
        return (
          <button key={level} type="button" role="radio" data-item="" aria-checked={on} tabIndex={on || (!used && index === 0) ? 0 : -1} onClick={() => picker.pick(picker.inHand, { effort: level })} className={cx(itemBase, "w-full pe-2 text-start hover:bg-fill focus-visible:bg-fill")}>
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

/** The columns both variants share: the rail, search and models, and effort rows; `below` goes under the levels. */
function Columns({ picker, below, ...props }: Props & { picker: Picker; below?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // As tall as its longest column, to a limit; open, it grows but never shrinks, so the search stays put while typing.
  useLayoutEffect(() => {
    const el = box.current!;
    el.style.minHeight = `${Math.max(Number.parseFloat(el.style.minHeight) || 0, el.offsetHeight)}px`;
  });
  return (
    <div ref={box} className="flex max-h-96 min-h-0">
      <Rail picker={picker} {...props} bar />
      <div className="flex min-w-0 flex-1 flex-col border-s border-divider">
        <Search picker={picker} className="mx-3 h-10 border-b border-divider" />
        <Models picker={picker} {...props} />
      </div>
      {props.efforts && (
        <div className={cx("flex shrink-0 flex-col border-s border-divider", below ? "w-52" : "w-36")}>
          <div className="mx-3 flex h-10 shrink-0 items-center border-b border-divider text-label text-muted-foreground">Effort</div>
          <div className="px-3 pt-2 text-xs text-placeholder">{picker.inHand.model.name}</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
            <EffortRows picker={picker} {...props} />
          </div>
          {below}
        </div>
      )}
    </div>
  );
}

/** Fast as a switch, greyed for a model without a fast tier; on the row the third column is about. */
function FastSwitch({ picker, value, row, className }: Props & { picker: Picker; row: Row; className?: string }) {
  const { model } = row;
  const on = Boolean(value.fast && model.fast && picker.inUse(row));
  return (
    <label title={model.fast ?? `${model.name} has no fast tier`} className={cx("flex items-center gap-1.5 text-label", model.fast ? "cursor-pointer" : "text-placeholder", className)}>
      <Bolt aria-hidden className={cx("size-icon-sm", on ? "text-glyph-5" : "text-placeholder")} />
      <span className="flex-1">Fast</span>
      <Switch aria-label="Fast" checked={on} disabled={!model.fast} onCheckedChange={(fast) => picker.pick(row, picker.inUse(row) && value.effort ? { fast, effort: value.effort } : { fast }, true)} />
    </label>
  );
}

/** What each account of the agent in hand has left. */
function Usage({ picker, className }: { picker: Picker; className: string }) {
  const group = picker.group?.unavailable ? picker.group : picker.inHand.group;
  return (
    <div className={className}>
      {group.usage ? group.usage.map((account) => <Left key={account.account} account={account} />) : <p className="text-xs text-muted-foreground">{group.label} reports no limits</p>}
    </div>
  );
}

const FOOT = "border-t border-divider bg-fill-faint px-3 py-2.5";

/** A: Fast and the usage under the effort levels; no footer. With no effort column, the usage goes under the models. */
function VariantA(props: Props) {
  const picker = usePicker(props);
  return (
    <Frame picker={picker} {...props} className={props.efforts ? "w-140" : "w-96"}>
      <Columns
        picker={picker}
        {...props}
        below={
          <div className="mx-3 shrink-0 border-t border-divider">
            <FastSwitch picker={picker} row={picker.inHand} {...props} className="py-2.5" />
            <Usage picker={picker} className="flex flex-col gap-2 border-t border-divider pt-2.5 pb-3" />
          </div>
        }
      />
      {!props.efforts && <Usage picker={picker} className={cx(FOOT, "flex flex-col gap-2")} />}
    </Frame>
  );
}

/** B: the same two in a footer, the accounts side by side. Its Fast is the model in use's: on the way down the pointer crosses other rows. */
function VariantB(props: Props) {
  const picker = usePicker(props);
  return (
    <Frame picker={picker} {...props} className={props.efforts ? "w-132" : "w-96"}>
      <Columns picker={picker} {...props} />
      <div className={cx(FOOT, "flex items-center gap-4")}>
        <Usage picker={picker} className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-2 *:flex-1 *:basis-38" />
        {props.efforts && <FastSwitch picker={picker} row={picker.used} {...props} className="shrink-0 gap-2 border-s border-divider ps-4" />}
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

function Frame({ picker, groups, onChange, close, className, children }: Props & { picker: Picker; className: string; children: ReactNode }) {
  return (
    <div ref={picker.root} data-slot="model-picker" className={cx("flex max-w-available flex-col overflow-hidden rounded-surface", className)}>
      {children}
      <SwitchAgentDialog
        to={picker.switching && (groups.find((each) => each.provider === picker.switching?.provider)?.label ?? null)}
        onCancel={() => picker.setSwitching(null)}
        onConfirm={() => {
          if (picker.switching) onChange(picker.switching);
          picker.setSwitching(null);
          close();
        }}
      />
    </div>
  );
}

const VARIANTS: Record<string, (props: Props) => ReactNode> = { a: VariantA, b: VariantB };
const variant = new URLSearchParams(location.search).get("v") ?? "a";
const Variant = VARIANTS[variant] ?? VariantA;

/** The menu at a trigger: the pill, a Settings select, Fork's button. */
function Menu({ open, setOpen, trigger, side, align, ...props }: Omit<Props, "close"> & { open: boolean; setOpen: (open: boolean) => void; trigger: ReactElement; side: "top" | "bottom"; align: "start" | "end" }) {
  const close = () => setOpen(false);
  useClosesOnTyping(open, close);
  return (
    <Popover open={open} onOpenChange={(next, details) => (details.reason === "focus-out" ? undefined : setOpen(next))}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side={side} align={align} padded={false} aria-label="Model" initialFocus={() => document.querySelector<HTMLElement>("[data-slot=model-picker] input")}>
        <Variant {...props} close={close} />
      </PopoverContent>
    </Popover>
  );
}

type Place = "chat" | "new" | "side" | "settings" | "fork";
const PLACES: { value: Place; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "new", label: "New chat" },
  { value: "side", label: "Side chat" },
  { value: "settings", label: "Settings" },
  { value: "fork", label: "Fork" },
];
const asked = new URLSearchParams(location.search).get("at");

function Page() {
  const [ready, setReady] = useState<Ready>("ready");
  const [offline, setOffline] = useState(false);
  const [place, setPlace] = useState<Place>(PLACES.find((each) => each.value === asked)?.value ?? "chat");
  const list = groups(ready);
  const [value, setValue] = useState<ModelChoice>({ provider: "claude", model: "opus", effort: "high", fast: true });
  const [writer, setWriter] = useState<ModelChoice>({ provider: "claude", model: "haiku", effort: null });
  const [stars, setStars] = useState<ReadonlySet<string>>(new Set(["claude/opus", "claude/sonnet", "codex/sol"]));
  const [open, setOpen] = useState<"main" | "writer" | null>("main");
  const [level, setLevel] = useState<PermissionLevel>("auto");
  useEffect(() => {
    const press = (event: globalThis.KeyboardEvent) => {
      if (!matches(event, "model") || offline) return;
      event.preventDefault();
      setOpen((now) => (now ? null : "main"));
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [offline]);
  const menu = (id: "main" | "writer", more: { trigger: ReactElement; side: "top" | "bottom"; align: "start" | "end"; asksSwitch: boolean; efforts?: boolean }) => (
    <Menu
      open={open === id}
      setOpen={(next) => setOpen(next ? id : null)}
      groups={list}
      value={id === "main" ? value : writer}
      onChange={id === "main" ? setValue : setWriter}
      stars={stars}
      onStar={(key) => setStars((now) => (now.has(key) ? new Set([...now].filter((each) => each !== key)) : new Set([...now, key])))}
      onSetUp={(group) => (setOpen(null), showToast(`Set up ${group.label} opens here`))}
      efforts
      {...more}
    />
  );
  const composer = (asksSwitch: boolean) => (
    <SharedComposer
      plus={<PlusButton />}
      level={<PermissionPicker value={level} onChange={setLevel} />}
      ring={<ContextRing usedTokens={45_000} windowTokens={258_000} />}
      model={menu("main", {
        side: "top",
        align: "end",
        asksSwitch,
        trigger: (
          <ComposerPill aria-label={modelWords(list, value)} disabled={offline}>
            <ModelLabel groups={list} value={value} mark="size-icon-sm" />
          </ComposerPill>
        ),
      })}
      send={<SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}
    >
      <div role="textbox" tabIndex={0} contentEditable="plaintext-only" suppressContentEditableWarning aria-label="Message" data-placeholder="Do anything" className="min-h-composer px-2 py-2.5 text-base outline-none empty:before:text-placeholder empty:before:content-[attr(data-placeholder)]" />
    </SharedComposer>
  );
  const thread = (
    <div className="min-h-0 w-full flex-1 overflow-hidden px-scrollbar">
      <div className={cx(COLUMN, "flex flex-col gap-4 py-6 text-chat")}>
        <UserBubble keep="u1" text="Why does the tab test fail now and then?" />
        <p>It reads the strip before the closing tab has gone. It now waits for that.</p>
        {place === "fork" && (
          <div>
            {menu("main", {
              side: "bottom",
              align: "start",
              asksSwitch: false,
              trigger: (
                <button type="button" className={cx(SETUP_BUTTON, "gap-1.5")}>
                  <BranchAlt aria-hidden className="size-icon-sm" />
                  Fork with another agent
                </button>
              ),
            })}
          </div>
        )}
      </div>
    </div>
  );
  return (
    <main className="flex h-screen min-h-160 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-4 py-2 text-xs text-muted-foreground">
        Mockup:
        <Segmented label="Place" value={place} onChange={(next) => (setPlace(next), setOpen(null))} options={PLACES} />
        OpenCode is
        <Segmented label="OpenCode" value={ready} onChange={setReady} options={[{ value: "ready", label: "Ready" }, { value: "sign-in", label: "Not signed in" }, { value: "install", label: "Not installed" }]} />
        <label className="flex items-center gap-1.5">
          Offline
          <Switch aria-label="Offline" checked={offline} onCheckedChange={(next) => (setOffline(next), setOpen(null))} />
        </label>
      </div>
      {place === "settings" ? (
        <div className="mx-auto w-full max-w-reading p-6">
          <SettingsCard>
            <SettingsRow label="Start with" description="Routing and rules: a model with its effort">
              {menu("main", { side: "bottom", align: "end", asksSwitch: false, trigger: <SelectTrigger label="Start with"><ModelLabel groups={list} value={value} mark="size-icon-sm" /></SelectTrigger> })}
            </SettingsRow>
            <SettingsRow label="Write with" description="Git: a model alone, so two columns">
              {menu("writer", { side: "bottom", align: "end", asksSwitch: false, efforts: false, trigger: <SelectTrigger label="Write with"><ModelLabel groups={list} value={writer} efforts={false} mark="size-icon-sm" /></SelectTrigger> })}
            </SettingsRow>
          </SettingsCard>
        </div>
      ) : place === "new" ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end pb-24">
          {composer(false)}
        </div>
      ) : place === "side" ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1" />
          <div className="flex w-96 shrink-0 flex-col border-s border-divider">
            {thread}
            {composer(true)}
          </div>
        </div>
      ) : (
        <>
          {thread}
          {place === "chat" && composer(true)}
        </>
      )}
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(VARIANTS[variant] ? <Page /> : <p className="p-4 text-label">This variant was dropped. Its round keeps its screenshot.</p>);
