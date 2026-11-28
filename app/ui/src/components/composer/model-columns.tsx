import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Bolt, Check, ChevronDown, MagnifyingGlassSmSearch, Star, StarFilled } from "../../icons";
import { run } from "../../onboarding/api";
import { keysOf, matches } from "../../shortcuts";
import { cx } from "../cx";
import { Kbd } from "../kbd";
import { itemBase } from "../menu";
import { RowAction } from "../row-action";
import { Switch } from "../switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { fuzzyMatch, MatchedText } from "./menus";
import { favorites, star } from "./model-keys";
import { effortLabel, type Model, type ModelGroup, type PickerProps, ProviderMark } from "./model-picker";
import { effortOf } from "../../../../shared/session/model";
import { type Quota, QuotaLeft } from "./quota-lines";
import { SwitchAgentDialog } from "./switch-agent";

type Row = { group: ModelGroup; model: Model };
const keyOf = ({ group, model }: Row) => `${group.provider}/${model.id}`;
const FAVORITES = "favorites";

export type ColumnsProps = PickerProps & { close: () => void };

/** The menu's state: the agent browsed, the search, the row under the keyboard, picks. */
function useColumns({ groups, value, onChange, close, asksSwitch = true }: ColumnsProps) {
  const stars = favorites.use();
  const all: Row[] = groups.flatMap((each) => (each.unavailable ? [] : each.models.map((model) => ({ group: each, model }))));
  const inUseKey = `${value.provider}/${value.model}`;
  // A value no agent lists (Add model's nothing yet) browses the first agent.
  const [tab, setTab] = useState(() => (all.some((row) => stars.includes(keyOf(row))) ? FAVORITES : (groups.find((each) => each.provider === value.provider) ?? groups[0])?.provider));
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [switching, setSwitching] = useState<PickerProps["value"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(inUseKey);
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const group = groups.find((each) => each.provider === tab) ?? null;
  const needle = query.trim();
  const rows = needle
    ? all.map((row) => ({ row, rank: fuzzyMatch(row.model.name, needle)?.rank })).filter((each) => each.rank !== undefined).toSorted((a, b) => a.rank! - b.rank!).map((each) => each.row)
    : tab === FAVORITES
      ? all.filter((row) => stars.includes(keyOf(row)))
      : all.filter((row) => row.group.provider === tab).toSorted((a, b) => Number(a.model.legacy ?? false) - Number(b.model.legacy ?? false));
  const isOld = (row: Row) => !needle && tab !== FAVORITES && row.model.legacy === true && keyOf(row) !== inUseKey && !stars.includes(keyOf(row));
  const hidden = rows.filter(isOld).length;
  const shown = older ? rows : rows.filter((row) => !isOld(row));
  const found = shown.findIndex((row) => keyOf(row) === cursor);
  const at = found < 0 && needle ? 0 : found;
  const used = all.find((row) => keyOf(row) === inUseKey) ?? null;

  /** The row the third column is about: the highlighted one, else the model in use. */
  const inHand = shown[at] ?? used;
  const inUse = (row: Row) => keyOf(row) === inUseKey;

  /**
   * Picks a model, with a level or Fast where one was clicked, and closes; Fast (`stay`) keeps it open. Within the agent
   * a new model keeps the effort when it has that level, else takes its own default.
   */
  const pick = ({ group, model }: Row, also: { effort?: string; fast?: boolean } = {}, stay = false) => {
    const same = group.provider === value.provider;
    const effort = effortOf(model, group.provider, value, inUse({ group, model }), also.effort);
    const choice = { provider: group.provider, model: model.id, effort, ...(model.fast && (also.fast ?? value.fast) ? { fast: true } : {}) };
    setCursor(keyOf({ group, model }));
    if (!same && asksSwitch) return setSwitching(choice);
    onChange(choice);
    if (!stay) close();
  };
  // ⌘1–9 pick the first nine while it's open; the tabs' own keys are off then (shell/titlebar's `blocked`).
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
    setCursor(inUseKey);
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
  return { id, stars, tab, browse, group, query, setQuery, needle, shown, hidden, older, setOlder, at, setCursor, used, inHand, inUse, pick, field, root, searchKeys, columnKeys, switching, setSwitching };
}
type Picker = ReturnType<typeof useColumns>;

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
        aria-controls={picker.id}
        aria-activedescendant={picker.at >= 0 ? `${picker.id}-${picker.at}` : undefined}
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
function Models({ picker, onSetUp }: ColumnsProps & { picker: Picker }) {
  const { group, shown, needle, tab } = picker;
  const mixed = Boolean(needle) || tab === FAVORITES;
  // Whether the pointer chose the row: coming in sideways from the agents, it takes the row it lands on.
  const pointed = useRef(false);
  const note = "px-2 py-1.5 text-label text-muted-foreground";
  return (
    <div id={picker.id} data-part="models" role="listbox" aria-label="Models" onMouseLeave={() => (pointed.current = false)} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
      {shown.map((row, index) => {
        const key = keyOf(row);
        const used = picker.inUse(row);
        const starred = picker.stars.includes(key);
        return (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- the search field's keys move and pick
          <div
            key={key}
            id={`${picker.id}-${index}`}
            role="option"
            aria-selected={used}
            data-highlighted={index === picker.at || undefined}
            // A move to the right keeps the row: the pointer is on its way to the effort levels.
            onMouseMove={(event) => {
              if (pointed.current && event.movementX > Math.abs(event.movementY)) return;
              pointed.current = true;
              picker.setCursor(key);
            }}
            className={cx(itemBase, "group/row shrink-0 pe-2")}
            onClick={() => picker.pick(row)}
          >
            <ProviderMark mark={row.group.mark} className="size-icon-md" />
            <span className="min-w-0 py-1 wrap-break-word">{needle ? <MatchedText text={row.model.name} query={needle} hit="font-semibold text-foreground" /> : row.model.name}</span>
            {used && <Check aria-label="In use" className="size-icon-sm text-foreground" />}
            {row.model.legacy && mixed && <span className="text-xs text-placeholder">Older</span>}
            <RowAction
              aria-label={starred ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={starred}
              className={cx("ms-auto", !starred && "opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100")}
              onClick={(event) => (event.stopPropagation(), star(key))}
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
      {!needle && group?.unavailable && <NotSetUp group={group} onSetUp={onSetUp} />}
      {!needle && group && !group.unavailable && shown.length === 0 && <p className={note}>No models listed yet</p>}
      {needle && shown.length === 0 && <p className={note}>No models match “{needle}”</p>}
      {!needle && tab === FAVORITES && shown.length === 0 && <p className={note}>Star a model and it shows here.</p>}
    </div>
  );
}

const SETUP_BUTTON = "flex h-control-sm shrink-0 cursor-pointer items-center rounded-capsule bg-control px-3 text-label font-medium text-foreground hover:bg-selection focus-visible:focus-ring";

function NotSetUp({ group, onSetUp }: { group: ModelGroup; onSetUp?: (provider: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-label text-muted-foreground">
      <ProviderMark mark={group.mark} className="size-icon-mark opacity-picker-dim" />
      <p>{group.unavailable === "install" ? `${group.label} isn't installed. Install it and its models show here.` : `${group.label} isn't signed in. Sign in and its models show here.`}</p>
      {onSetUp && (
        <button type="button" aria-label={`Set up ${group.label}`} className={SETUP_BUTTON} onClick={() => onSetUp(group.provider)}>
          Set up
        </button>
      )}
    </div>
  );
}

/** The levels as rows, a check on the one in use and the model's own default named. */
function EffortRows({ picker, row, value }: ColumnsProps & { picker: Picker; row: Row }) {
  const { model } = row;
  const used = picker.inUse(row);
  if (model.efforts.length === 0) return <p className="px-2 py-1.5 text-label text-muted-foreground">No effort levels</p>;
  return (
    <div data-part="effort" role="radiogroup" aria-label="Effort" onKeyDown={picker.columnKeys("ArrowLeft")} className="flex flex-col gap-px">
      {model.efforts.map((level, index) => {
        const on = used && value.effort === level;
        return (
          <button key={level} type="button" role="radio" data-item="" aria-checked={on} tabIndex={on || (!used && index === 0) ? 0 : -1} onClick={() => picker.pick(row, { effort: level })} className={cx(itemBase, "w-full pe-2 text-start hover:bg-fill focus-visible:bg-fill")}>
            <span className="flex-1 truncate">{effortLabel(level)}</span>
            {on ? <Check aria-hidden className="size-icon-sm text-foreground" /> : level === model.defaultEffort && <span className="text-xs text-placeholder">Default</span>}
          </button>
        );
      })}
    </div>
  );
}

const RAIL_BUTTON = "relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-icon-button text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:focus-ring aria-pressed:text-foreground aria-pressed:bg-selection";

/** The agents as marks, Favorites over them, a short line by the one browsed. */
function Rail({ picker, groups }: ColumnsProps & { picker: Picker }) {
  const line = (on: boolean) => on && <span aria-hidden className="absolute -end-1 h-5 w-0.75 rounded-full bg-foreground" />;
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

/** The agents' rail, the search and models, and the effort levels of the row in hand. */
function Columns({ picker, ...props }: ColumnsProps & { picker: Picker }) {
  // As tall as its longest column, to a limit; until another agent is browsed it never shrinks, so the search stays put while typing.
  const rows = Math.max(picker.shown.length + Number(picker.hidden > 0), props.efforts === false ? 0 : (picker.inHand?.model.efforts.length ?? 0) + 1);
  const [most, setMost] = useState({ tab: picker.tab, rows });
  if (picker.tab !== most.tab || rows > most.rows) setMost({ tab: picker.tab, rows });
  return (
    <div data-rows={most.rows} className="flex max-h-96 min-h-picker-rows">
      <Rail picker={picker} {...props} />
      <div className="flex min-w-0 flex-1 flex-col border-s border-divider">
        <Search picker={picker} className="mx-3 h-10 border-b border-divider" />
        <Models picker={picker} {...props} />
      </div>
      {props.efforts !== false && (
        <div className="flex w-36 shrink-0 flex-col border-s border-divider">
          <div className="mx-3 flex h-10 shrink-0 items-center border-b border-divider text-label text-muted-foreground">Effort</div>
          {picker.inHand && (
            <>
              <div className="px-3 pt-2 text-xs text-placeholder">{picker.inHand.model.name}</div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1 scroll-edge-fade edge-fade-group">
                <EffortRows picker={picker} row={picker.inHand} {...props} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Fast as a switch, greyed for a model without a fast tier. */
function FastSwitch({ picker, value, row, className }: ColumnsProps & { picker: Picker; row: Row; className?: string }) {
  const { model } = row;
  const on = Boolean(value.fast && model.fast && picker.inUse(row));
  return (
    <label title={model.fast ?? `${model.name} has no fast tier`} className={cx("flex items-center gap-1.5 text-label", model.fast ? "cursor-pointer" : "text-placeholder", className)}>
      <Bolt aria-hidden className={cx("size-icon-sm", on ? "text-glyph-5" : "text-placeholder")} />
      <span className="flex-1">Fast</span>
      <Switch aria-label="Fast" checked={on} disabled={!model.fast} onCheckedChange={(fast) => picker.pick(row, { fast }, true)} />
    </label>
  );
}

/** What each account of the agent browsed has left; in Favorites and the search, of the row in hand. */
function Usage({ picker, className }: { picker: Picker; className: string }) {
  // Usage moves while the list stays: each open reads it again, as the Usage popover does [D2039].
  const [usage, setUsage] = useState<Record<string, Quota[] | null>>({});
  useEffect(() => {
    run(["models"]).then((reply) => setUsage(Object.fromEntries(reply.groups.map((each: ModelGroup) => [each.provider, each.usage ?? null]))), () => {});
  }, []);
  const group = (!picker.needle && picker.group) || picker.inHand?.group;
  if (!group) return <div className={className} />;
  const quota = group.provider in usage ? usage[group.provider] : group.usage;
  return <div className={className}>{quota?.length ? quota.map((account) => <QuotaLeft key={account.account} account={account} />) : <p className="text-xs text-muted-foreground">{group.label} reports no limits</p>}</div>;
}

/**
 * The model picker's menu [D84, D89, D91], the mockup's "In the footer" (B, round 2): the agents' rail with Favorites on
 * top, where it opens when there are any; one search over every agent's models; the effort levels of the highlighted
 * row, else of the model in use; and a footer with what each account has left and Fast. A pick, of a model or a level,
 * closes it; Fast keeps it open, and is the model in use's, as the pointer crosses other rows on its way down. An agent
 * not installed or not signed in is dimmed, with Set up in place of its models. Another agent's model asks "Switch to
 * X?" first. Without `efforts`, two columns.
 */
export function ModelColumns(props: ColumnsProps) {
  const picker = useColumns(props);
  const { groups, onChange, close, efforts = true } = props;
  return (
    <div ref={picker.root} data-slot="model-picker" className={cx("flex max-w-available flex-col overflow-hidden rounded-surface", efforts ? "w-132" : "w-96")}>
      <Columns picker={picker} {...props} />
      <div className="flex items-center gap-4 border-t border-divider bg-fill-faint px-3 py-2.5">
        <Usage picker={picker} className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-2 *:flex-1 *:basis-38" />
        {efforts && picker.used && <FastSwitch picker={picker} row={picker.used} {...props} className="shrink-0 gap-2 border-s border-divider ps-4" />}
      </div>
      <SwitchAgentDialog
        to={picker.switching && (groups.find((each) => each.provider === picker.switching?.provider)?.label ?? picker.switching.provider)}
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
