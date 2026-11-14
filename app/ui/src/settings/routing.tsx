import { type ComponentType, useEffect, useRef, useState } from "react";

import { effortLabel, type ModelGroup, ProviderMark } from "../components/composer/model-picker";
import { named } from "../components/composer/model-keys";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { RowText, SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { Bolt, ChevronRight, ChevronUp, Code, type IconProps, Nodes } from "../icons";
import { errorText, run } from "../onboarding/api";
import { asGroups } from "../session/model";
import { SettingsPage, SettingsSection } from "./parts";
import { OrderList } from "./routing-order";
import { type Results, YourResults } from "./routing-results";
import { Rules } from "./routing-rules";

/** One place in a row's order (C4); `effort` null is the model's own default. */
export type Entry = { agent: string; model: string; effort: string | null };
/** A rule, added from menus and exact [D338, D341]: never a model, or never above an effort (on one agent, or every one). */
export type Rule = { never: "model"; agent: string; model: string } | { never: "above"; effort: string; agent: string | null };
export type RowName = "best" | "standard" | "quick";
/**
 * Rust's routing table (C4): the three rows [D2037], the rules, and 4.10's review switch [D3026]; `now` is each
 * row's first entry the rules allow, at the effort they let it run (null: none, so it can't start).
 */
export type Routing = { rows: Record<RowName, Entry[]>; rules: Rule[]; review: boolean; now: Record<RowName, Entry | null> };

/** The page's rows, for Settings search; the page draws these words. */
export const ROUTING_ROWS = {
  rows: { label: "Who does what", description: "Each row tries your order: the first model your rules allow takes it" },
  rules: { label: "Rules", description: "Things every worker must follow" },
  review: { label: "Adversarial review", description: "A model from the other agent reviews the work" },
  results: { label: "Your results", description: "How often each model's work succeeded, from your own workers" },
} as const;

const ROWS: { row: RowName; title: string; icon: ComponentType<IconProps> }[] = [
  { row: "best", title: "Best", icon: Nodes },
  { row: "standard", title: "Standard", icon: Code },
  { row: "quick", title: "Quick", icon: Bolt },
];

/**
 * Settings › Routing, the old app's page cut to 4.5 [D2037, D2038, D338, D341]: who does what (Best, Standard and
 * Quick, each your order, opening in place), the review switch, the rules and your results. Pure props: a change
 * shows at once and settles on the value `onChange` returns, or goes back with Rust's words [D30]. `value` null is
 * loading; `review` and `results` left out draw nothing, until their steps wire them [D2079].
 */
export function RoutingPage({
  value,
  groups,
  onChange,
  error,
  offline = false,
  review = false,
  results,
}: {
  value: Routing | null;
  groups: ModelGroup[];
  onChange: (next: Routing) => Promise<Routing>;
  /** What reading the table failed with. */
  error?: string | null;
  /** Brigadier isn't running: the page shows the last table, dimmed. */
  offline?: boolean;
  review?: boolean;
  results?: Results | null;
}) {
  const [open, setOpen] = useState<RowName | null>(null);
  // A change in flight, or settled, on the table it was made from; a new table from Rust replaces it.
  const [mine, setMine] = useState<{ base: Routing; shown: Routing } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ops = useRef(0);
  const shown = mine && mine.base === value ? mine.shown : value;
  const change = (next: Routing) => {
    if (!value) return;
    const op = ++ops.current;
    const base = value;
    setMine({ base, shown: next });
    setFailed(null);
    onChange(next).then(
      (back) => op === ops.current && setMine({ base, shown: back }),
      (cause: unknown) => {
        if (op !== ops.current) return;
        setMine(null);
        setFailed(errorText(cause));
      },
    );
  };
  return (
    <SettingsPage title="Routing" description="Which agent, model and effort suit Best, Standard and Quick work. Changes apply to new work only.">
      {!shown ? (
        <SettingsCard>
          <SettingsRow label={ROUTING_ROWS.rows.label} description={error ? undefined : "Loading…"} error={error} />
        </SettingsCard>
      ) : (
        <div className={cx("flex flex-col gap-10", offline && "pointer-events-none opacity-disabled")}>
          <ErrorLine error={failed ?? error} />
          <SettingsSection title={ROUTING_ROWS.rows.label} description={ROUTING_ROWS.rows.description}>
            <SettingsCard inset data-slot="who-does-what">
              {ROWS.map(({ row, title, icon }) => (
                <KindRow
                  key={row}
                  title={title}
                  icon={icon}
                  order={shown.rows[row]}
                  now={shown.now[row]}
                  groups={groups}
                  open={open === row}
                  onToggle={() => setOpen(open === row ? null : row)}
                  onSave={(order) => change({ ...shown, rows: { ...shown.rows, [row]: order } })}
                />
              ))}
            </SettingsCard>
            {review && (
              <SettingsCard>
                <SettingsRow label={ROUTING_ROWS.review.label} description={ROUTING_ROWS.review.description}>
                  <Switch aria-label={ROUTING_ROWS.review.label} checked={shown.review} onCheckedChange={(on) => change({ ...shown, review: on })} />
                </SettingsRow>
              </SettingsCard>
            )}
          </SettingsSection>
          <Rules rules={shown.rules} groups={groups} onSave={(rules) => change({ ...shown, rules })} />
          {results !== undefined && <YourResults results={results} groups={groups} />}
        </div>
      )}
    </SettingsPage>
  );
}

/** The page in Settings: Rust's table and models, a change saved through the routing op and settled on its reply [C4, D30]. */
export function RoutingSettings() {
  const online = Boolean(useDaemon().daemon);
  const [value, setValue] = useState<Routing | null>(null);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => {
    if (!online) return;
    setError(null);
    // Your results read every worker's log, so the table never waits on them [D2038].
    run(["routing", "results"]).then((back) => setResults(back as Results), (cause) => setError(errorText(cause)));
    Promise.all([run(["routing"]), run(["models"])]).then(
      ([table, models]) => {
        setValue(table as Routing);
        setGroups(asGroups(models.groups));
      },
      (cause) => setError(errorText(cause)),
    );
  }, [online]);
  const save = (next: Routing) =>
    run(["routing", "set", JSON.stringify({ rows: next.rows, rules: next.rules, review: next.review })]).then((back) => {
      setValue(back as Routing);
      return back as Routing;
    });
  return <RoutingPage value={value} groups={groups} onChange={save} error={error} offline={!online} results={results} review />;
}

/** "✻ Opus 5.5 · High": the agent's mark, the model, then its effort after a dot (no effort: just the model). */
export function ModelEffort({ entry, groups }: { entry: Entry; groups: readonly ModelGroup[] }) {
  const mark = groups.find((group) => group.provider === entry.agent)?.mark ?? null;
  return (
    <span data-slot="now-pick" className="flex min-w-0 shrink-0 items-center gap-1.75 text-xs">
      <ProviderMark mark={mark} className="size-3.5" />
      <span className="truncate text-foreground">{named(groups, entry.agent, entry.model)}</span>
      {entry.effort && (
        <>
          <span className="size-0.75 shrink-0 rounded-full bg-muted-foreground">
            <span className="sr-only"> · </span>
          </span>
          <span className="shrink-0 text-muted-foreground">{effortLabel(entry.effort)}</span>
        </>
      )}
    </span>
  );
}

/** A row of Who does what: its icon, name and your order, the model it starts on now (the first your rules allow); open, My order. */
function KindRow({
  title,
  icon: Icon,
  order,
  now,
  groups,
  open,
  onToggle,
  onSave,
}: {
  title: string;
  icon: ComponentType<IconProps>;
  order: Entry[];
  now: Entry | null;
  groups: ModelGroup[];
  open: boolean;
  onToggle: () => void;
  onSave: (order: Entry[]) => void;
}) {
  const names = order.map((entry) => named(groups, entry.agent, entry.model));
  const who = `Your order · ${names.join(", then ")}`;
  const line = order.length === 0 ? "Your order · empty, so it can't start" : now ? who : `${who} · Your rules keep ${names.join(" and ")} out, so it can't start`;
  const Chevron = open ? ChevronUp : ChevronRight;
  return (
    <div data-slot="routing-kind" data-open={open || undefined} className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3.5 py-3.5 text-start">
        <Icon aria-hidden className="size-4 shrink-0 text-quiet-foreground" />
        <RowText truncate title={title} line={line} />
        {now && <ModelEffort entry={now} groups={groups} />}
        <Chevron aria-hidden className="size-icon-sm shrink-0 text-muted-foreground" />
      </button>
      {open && <OrderList title={title} order={order} groups={groups} onSave={onSave} />}
    </div>
  );
}
